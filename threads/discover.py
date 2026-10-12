"""Поиск чужих обсуждений в Threads и черновики ответов.

Поиск идёт через Serper (выдача Google по threads.net / threads.com): поиск по
ключевым словам в самом Threads API закрыт до App Review. Страницы Threads не
скачиваются — модель видит только заголовок и сниппет из выдачи, поэтому ответ
публикуется вручную, после того как владелица прочла пост целиком.
"""
import html
import logging
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

from . import config, db, llm
from .notify import send

log = logging.getLogger("threads.discover")

ENDPOINT = "https://google.serper.dev/search"
POST_URL = re.compile(r"^https?://(?:www\.)?threads\.(?:net|com)/@([\w.]+)/post/([\w-]+)", re.I)
BATCH = 15
KEEP_REJECTED_DAYS = 30

SCHEMA = {
    "type": "object",
    "properties": {"leads": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "score": {"type": "integer"},
            "reason": {"type": "string"},
            "reply": {"type": "string"},
        },
        "required": ["id", "score", "reason", "reply"], "additionalProperties": False}}},
    "required": ["leads"], "additionalProperties": False,
}


def normalize(url):
    """(канонический адрес поста, ник автора) или None, если это не пост Threads."""
    m = POST_URL.match(url or "")
    if not m:
        return None
    return f"https://www.threads.com/@{m.group(1)}/post/{m.group(2)}", m.group(1).lower()


def search(query, account, session=requests):
    cfg = account["search"]
    body = {"q": f"{query} (site:threads.net OR site:threads.com)", "num": 10,
            "gl": cfg.get("gl", "us"), "hl": cfg.get("hl", "en"),
            "tbs": f"qdr:d{int(cfg.get('freshness_days', 7))}"}
    res = session.post(ENDPOINT, json=body, timeout=20,
                       headers={"X-API-KEY": config.SERPER_API_KEY, "Content-Type": "application/json"})
    if res.status_code != 200:
        raise RuntimeError(f"Serper: HTTP {res.status_code}")
    return res.json().get("organic") or []


def discover(con, account, session=requests):
    """Прогоняет дневную порцию запросов из банка, сохраняет новые посты. Возвращает их число."""
    cfg = account.get("search") or {}
    queries = cfg.get("queries") or []
    if not queries:
        return 0
    if not config.SERPER_API_KEY:
        log.warning("SERPER_API_KEY не задан — поиск обсуждений выключен")
        return 0
    own = {r["username"].lower() for r in con.execute(
        "SELECT username FROM threads_tokens WHERE username IS NOT NULL")}
    pos = int(db.get_state(con, f"qpos:{account.id}", "0"))
    per_day = min(int(cfg.get("per_day", 6)), len(queries))
    found = 0
    for i in range(per_day):
        query = queries[(pos + i) % len(queries)]
        try:
            items = search(query, account, session)
        except (requests.RequestException, RuntimeError, ValueError) as e:
            log.error("%s: поиск «%s» не удался: %s", account.id, query, e)
            break
        for item in items:
            norm = normalize(item.get("link"))
            if not norm or norm[1] in own:
                continue
            cur = con.execute(
                "INSERT OR IGNORE INTO threads_leads (account, url, author, title, snippet, query, "
                "found_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (account.id, norm[0], norm[1], (item.get("title") or "")[:300],
                 re.sub(r"\s+", " ", item.get("snippet") or "")[:600], query, db.utcnow(), db.utcnow()))
            found += cur.rowcount
    db.set_state(con, f"qpos:{account.id}", (pos + per_day) % len(queries))
    con.commit()
    log.info("%s: найдено новых обсуждений: %s", account.id, found)
    return found


def build_prompt(account, rows):
    system = f"""Ты помогаешь основателю продукта {account['brand']} находить в Threads разговоры,
в которых уместно поучаствовать. Язык ответа — язык поста. Аудитория продукта: {account['audience']}.

<voice>
{account.voice}
</voice>

<facts>
{account.facts}
</facts>

Тебе дают посты: ник, заголовок и сниппет из поисковой выдачи (текст может быть обрезан).
Для каждого верни:
- score 0–100: насколько стоит ответить. Высокий балл — только если автор сам из целевой
  аудитории, описывает реальную рабочую проблему или задаёт вопрос, и ответ от основателя
  профильного продукта будет к месту. Слова вроде booking, beauty, CRM сами по себе ничего
  не значат. Реклама, новости, клиенты салонов, посты других сервисов, шутки, обрезанный
  до непонятности текст — низкий балл.
- reason: одна фраза по-русски, почему такой балл.
- reply: черновик ответа, если score от {account['search'].get('min_score', 70)}; иначе пустая строка.

Правила ответа:
- Сначала польза по конкретной ситуации человека; ответ должен быть ценен и без продукта.
- Автор ответа — основатель, который делает такой инструмент, а не практикующий специалист.
  Никакого выдуманного опыта работы с клиентами, никаких выдуманных историй и цифр.
- Продукт упоминается только если человек прямо ищет инструмент или спрашивает, чем пользуются
  другие, — одной фразой, от первого лица («я делаю …»), только по <facts>, без ссылки.
  Во всех остальных случаях продукт не упоминается вовсе.
- 1–3 предложения, разговорно, без приветствий, эмодзи, хэштегов и призывов.
- Каждый ответ написан под свой пост: никаких повторяющихся заготовок."""
    posts = "\n\n".join(f"id: {r['id']}\n@{r['author']}\n{r['title']}\n{r['snippet']}" for r in rows)
    return system, f"Посты:\n\n{posts}"


def qualify(con, account, client=None):
    """Оценивает новые обсуждения и пишет черновики. Возвращает число черновиков."""
    rows = con.execute("SELECT * FROM threads_leads WHERE account = ? AND status = 'discovered' "
                       "ORDER BY id LIMIT ?", (account.id, BATCH)).fetchall()
    if not rows:
        return 0
    system, user = build_prompt(account, rows)
    data = llm.call_json(con, account.id, "leads", system, user, SCHEMA, client=client)
    by_id = {item["id"]: item for item in data["leads"]}
    min_score = int(account["search"].get("min_score", 70))
    drafted = 0
    for row in rows:
        item = by_id.get(row["id"])
        if not item:  # модель пропустила пост — оценим в следующий раз
            continue
        score = max(0, min(100, int(item["score"])))
        reply = item["reply"].strip()
        ok = score >= min_score and bool(reply)
        con.execute("UPDATE threads_leads SET score = ?, reason = ?, draft = ?, status = ?, updated_at = ? "
                    "WHERE id = ?",
                    (score, item["reason"][:300], reply if ok else None,
                     "drafted" if ok else "rejected", db.utcnow(), row["id"]))
        drafted += ok
    con.commit()
    return drafted


def lead_message(row):
    e = html.escape
    return (f"<b>{e(row['account'])}</b> · {row['score']}/100\n"
            f"<i>{e(row['reason'] or '')}</i>\n\n"
            f"@{e(row['author'] or '')}: {e(row['snippet'] or row['title'] or '')}\n"
            f"{e(row['url'])}\n\n"
            f"Черновик (нажми, чтобы скопировать):\n<code>{e(row['draft'] or '')}</code>")


def lead_buttons(lead_id):
    return [[("✅ Ответила", f"lp:{lead_id}"), ("✖️ Пропустить", f"lr:{lead_id}")]]


def send_drafts(con, account):
    """Шлёт владелице лучшие неотправленные черновики, не больше дневного лимита."""
    limit = int(account["search"].get("max_leads_per_day", 5))
    rows = con.execute(
        "SELECT * FROM threads_leads WHERE account = ? AND status = 'drafted' AND tg_message_id IS NULL "
        "ORDER BY score DESC, id LIMIT ?", (account.id, limit)).fetchall()
    sent = 0
    for row in rows:
        message_id = send(lead_message(row), lead_buttons(row["id"]))
        if message_id:
            con.execute("UPDATE threads_leads SET tg_message_id = ? WHERE id = ?", (message_id, row["id"]))
            sent += 1
    con.commit()
    return sent


def due_today(con, account, now=None):
    """True один раз в сутки, после часа search.hour в поясе аккаунта."""
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(ZoneInfo(account["timezone"]))
    if local.hour < int((account.get("search") or {}).get("hour", 8)):
        return False
    return db.once(con, f"discover_day:{account.id}", f"{local:%Y-%m-%d}")


def purge(con):
    """Стирает ник, сниппет и черновик у отклонённых обсуждений старше месяца.

    Ссылка остаётся — по ней пост не попадёт в выдачу повторно.
    """
    con.execute(
        "UPDATE threads_leads SET author = NULL, title = NULL, snippet = NULL, draft = NULL "
        "WHERE status = 'rejected' AND julianday('now') - julianday(updated_at) > ?", (KEEP_REJECTED_DAYS,))
    con.commit()
