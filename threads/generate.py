"""Генерация постов аккаунта и пополнение очереди."""
import logging
import re
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

from . import config, db, llm, schedule

log = logging.getLogger("threads.generate")

RUBRICS = {
    "question": "вопрос к аудитории о том, как у них устроена работа; автору правда нужен ответ",
    "building": "заметка основателя о том, как делается продукт: решение, сомнение, ошибка",
    "observation": "наблюдение о работе частного специалиста, без морали и вывода-лозунга",
    "tip": "один конкретный практический совет по организации работы",
    "product": "ситуация, в которой помогает конкретная функция продукта (только из фактов)",
}
REGEN_PAUSE_HOURS = 6   # не чаще одной генерации на аккаунт за это время — защита от цикла
RECENT_FOR_DEDUP = 60

SCHEMA = {
    "type": "object",
    "properties": {"posts": {"type": "array", "items": {
        "type": "object",
        "properties": {"rubric": {"type": "string", "enum": list(RUBRICS)}, "text": {"type": "string"}},
        "required": ["rubric", "text"], "additionalProperties": False}}},
    "required": ["posts"], "additionalProperties": False,
}

_URL = re.compile(r"https?://|www\.|\b[\w-]+\.(?:com|ru|online|net|io|app)\b", re.I)
_MARKUP = re.compile(r"\*\*|__|^#{1,6}\s|^[-*•]\s", re.M)


def _words(text):
    return set(re.findall(r"\w{4,}", text.lower()))


def similarity(a, b):
    """0..1: максимум из посимвольной похожести и пересечения значимых слов."""
    wa, wb = _words(a), _words(b)
    jaccard = len(wa & wb) / len(wa | wb) if wa and wb else 0.0
    return max(jaccard, SequenceMatcher(None, a.lower(), b.lower()).ratio())


def validate(text, account, recent):
    """Причина, по которой пост нельзя ставить в очередь, или None."""
    if not text.strip():
        return "пустой текст"
    if len(text) > config.MAX_POST_LEN:
        return f"длиннее {config.MAX_POST_LEN} знаков"
    if _URL.search(text):
        return "ссылка в тексте"
    if "#" in text or _MARKUP.search(text):
        return "хэштег или разметка"
    low = text.lower()
    for phrase in account.banned:
        if phrase in low:
            return f"запрещённый оборот «{phrase}»"
    for old in recent:
        if similarity(text, old) >= config.SIMILARITY_THRESHOLD:
            return "слишком похож на недавний пост"
    return None


def build_prompt(account, count, recent):
    examples = "\n---\n".join(account.examples)
    rubrics = "\n".join(f"- {k}: {v}" for k, v in RUBRICS.items())
    system = f"""Ты пишешь посты для Threads от лица основателя продукта {account['brand']}.
Язык постов: {account['language']}. Аудитория: {account['audience']}.

<voice>
{account.voice}
</voice>

<facts>
{account.facts}
</facts>

<examples>
{examples}
</examples>

Примеры показывают голос, длину и ритм. Не повторяй их темы и формулировки — это уже опубликовано.

Правила:
- Пиши от первого лица, как человек, который делает продукт и разговаривает с теми, для кого он.
  Автор — основатель, а не практикующий специалист: никакого выдуманного опыта работы с клиентами.
- О продукте можно говорить только то, что есть в <facts>. Нет в фактах — значит, не упоминается:
  ни функций, ни цен, ни цифр, ни планов.
- Никаких выдуманных историй, клиентов, отзывов и статистики.
- Заметки основателя — это мнения, сомнения, намерения и вопросы. Конкретные события из работы
  над продуктом («потратила неделю на…», «меня попросили…», «выяснилось, что никто…») — только
  те, что прямо записаны в <voice> или видны в примерах. Не придумывай их.
- Продукт по имени — не чаще чем в одном посте из четырёх. Остальные посты ценны сами по себе.
- Без ссылок, хэштегов, эмодзи и разметки. Обычный текст, короткие строки, как в примерах.
- До 450 знаков. Короткий пост лучше длинного.
- Без рекламных крючков, призывов «напишите в комментариях» и итоговой морали в последней строке.
- Каждый пост о своём: разные темы и разные первые строки.

Рубрики:
{rubrics}"""
    recent_block = "\n---\n".join(recent[:25]) or "(пока ничего)"
    user = f"""Напиши {count} постов. Чередуй рубрики; вопросов и заметок основателя — больше, чем остальных.

Недавние посты аккаунта — не повторяй их темы и зачины:
{recent_block}"""
    return system, user


def recent_texts(con, account_id):
    rows = con.execute(
        "SELECT text FROM threads_posts WHERE account = ? AND status != 'cancelled' "
        "ORDER BY id DESC LIMIT ?", (account_id, RECENT_FOR_DEDUP)).fetchall()
    return [r["text"] for r in rows]


def generate(con, account, count, client=None):
    """Возвращает до count прошедших проверку постов: [{'rubric', 'text'}]. В базу не пишет."""
    if len(account.examples) < config.MIN_EXAMPLES:
        raise llm.LlmError(f"{account.id}: в examples.md меньше {config.MIN_EXAMPLES} эталонных постов")
    # Эталоны участвуют в проверке на повтор наравне с опубликованным.
    recent = recent_texts(con, account.id) + account.examples
    system, user = build_prompt(account, count + 2, recent)  # запас на отбраковку
    data = llm.call_json(con, account.id, "posts", system, user, SCHEMA, client=client)
    good = []
    for post in data["posts"]:
        text = post["text"].strip()
        reason = validate(text, account, recent + [g["text"] for g in good])
        if reason:
            log.info("%s: пост отбракован (%s)", account.id, reason)
            continue
        good.append({"rubric": post["rubric"], "text": text})
    return good[:count]


def refill(con, account, now=None, force=False, client=None):
    """Заполняет свободные слоты на QUEUE_DAYS вперёд. Возвращает число добавленных постов."""
    now = now or datetime.now(timezone.utc)
    free = schedule.free_slots(con, account, now, config.QUEUE_DAYS)
    if not free:
        return 0
    key = f"gen_last:{account.id}"
    last = db.get_state(con, key)
    if not force and last and now - db.parse_ts(last) < timedelta(hours=REGEN_PAUSE_HOURS):
        return 0
    db.set_state(con, key, db.fmt_ts(now))
    posts = generate(con, account, len(free), client=client)
    for (slot_key, when), post in zip(free, posts):
        con.execute(
            "INSERT INTO threads_posts (account, rubric, text, status, slot_key, scheduled_at, created_at) "
            "VALUES (?, ?, ?, 'scheduled', ?, ?, ?)",
            (account.id, post["rubric"], post["text"], slot_key, db.fmt_ts(when), db.utcnow()))
    con.commit()
    log.info("%s: в очередь добавлено %s из %s", account.id, len(posts), len(free))
    return len(posts)
