"""Управление из Telegram: команды, кнопки, правка поста ответом на сообщение.

Отвечает только владелице (TELEGRAM_OWNER_CHAT_ID), остальных молча игнорирует.
"""
import html
import logging
from zoneinfo import ZoneInfo

from . import config, db, discover, generate, llm, metrics
from .notify import send, tg

log = logging.getLogger("threads.bot")

HELP = """<b>Команды</b>
/status — аккаунты, очередь, расходы
/queue [аккаунт] — ближайшие посты; ответь на пост новым текстом, чтобы заменить его
/leads [аккаунт] — черновики ответов, которые ещё ждут
/stats [аккаунт] — отчёт за 7 дней
/gen аккаунт — дозаполнить очередь сейчас
/pause [аккаунт] — остановить аккаунт (без аргумента — всё)
/resume [аккаунт] — запустить"""


def _local(ts, tz=None):
    return db.parse_ts(ts).astimezone(ZoneInfo(tz or config.TZ)).strftime("%d.%m %H:%M")


def _pick(accounts, arg):
    """Аккаунты по аргументу команды: один названный или все."""
    if arg:
        return [accounts[arg]] if arg in accounts else None
    return list(accounts.values())


def cmd_status(con, accounts):
    lines = []
    if db.get_state(con, "paused_all") == "1":
        lines.append("⛔️ <b>Всё остановлено</b> (/resume)")
    for acc in accounts.values():
        state = "работает" if db.is_running(con, acc) else (
            "черновик" if acc["status"] == "draft" else "на паузе")
        auth = db.get_auth(con, acc.id)
        queued = con.execute("SELECT COUNT(*) AS n, MIN(scheduled_at) AS next FROM threads_posts "
                             "WHERE account = ? AND status = 'scheduled'", (acc.id,)).fetchone()
        failed = con.execute("SELECT COUNT(*) AS n FROM threads_posts WHERE account = ? AND status = 'failed'",
                             (acc.id,)).fetchone()["n"]
        line = f"<b>{html.escape(acc.id)}</b> — {state}"
        line += f", @{html.escape(auth['username'] or '?')}" if auth else ", <i>нет токена</i>"
        line += f"\n  в очереди {queued['n']}"
        if queued["next"]:
            line += f", следующий {_local(queued['next'])}"
        if failed:
            line += f", ошибок {failed}"
        lines.append(line)
    lines.append(metrics.spend_line(con) + f" из ${config.LLM_MONTHLY_BUDGET_USD:.0f}")
    send("\n".join(lines))


def cmd_queue(con, accounts, arg):
    picked = _pick(accounts, arg)
    if picked is None:
        return send("Нет такого аккаунта.")
    rows = con.execute(
        f"SELECT * FROM threads_posts WHERE status = 'scheduled' AND account IN "
        f"({','.join('?' * len(picked))}) ORDER BY scheduled_at LIMIT 12", [a.id for a in picked]).fetchall()
    if not rows:
        return send("Очередь пуста.")
    for row in rows:
        mid = send(f"<b>{html.escape(row['account'])}</b> · {_local(row['scheduled_at'])} · "
                   f"{html.escape(row['rubric'] or '')}\n\n{html.escape(row['text'])}",
                   [[("✖️ Отменить", f"pc:{row['id']}")]])
        if mid:
            con.execute("UPDATE threads_posts SET tg_message_id = ? WHERE id = ?", (mid, row["id"]))
    con.commit()


def cmd_leads(con, accounts, arg):
    picked = _pick(accounts, arg)
    if picked is None:
        return send("Нет такого аккаунта.")
    rows = con.execute(
        f"SELECT * FROM threads_leads WHERE status = 'drafted' AND account IN "
        f"({','.join('?' * len(picked))}) ORDER BY score DESC LIMIT 10", [a.id for a in picked]).fetchall()
    if not rows:
        return send("Черновиков ответов нет.")
    for row in rows:
        mid = send(discover.lead_message(row), discover.lead_buttons(row["id"]))
        if mid:
            con.execute("UPDATE threads_leads SET tg_message_id = ? WHERE id = ?", (mid, row["id"]))
    con.commit()


def cmd_pause(con, accounts, arg, paused):
    flag = "1" if paused else "0"
    if not arg:
        db.set_state(con, "paused_all", flag)
        if not paused:
            for acc in accounts.values():
                db.set_state(con, f"paused:{acc.id}", "0")
        return send("⛔️ Все публикации и поиск остановлены." if paused else "▶️ Всё запущено.")
    if arg not in accounts:
        return send("Нет такого аккаунта.")
    db.set_state(con, f"paused:{arg}", flag)
    if not paused and accounts[arg]["status"] != "active":
        return send(f"{arg}: в account.json статус «{accounts[arg]['status']}» — поменяй на active.")
    send(f"{'⏸' if paused else '▶️'} {arg}: {'на паузе' if paused else 'запущен'}.")


def cmd_gen(con, accounts, arg):
    if arg not in accounts:
        return send("Укажи аккаунт: /gen " + " | ".join(accounts))
    try:
        n = generate.refill(con, accounts[arg], force=True)
    except llm.LlmError as e:
        return send(f"Не получилось: {html.escape(str(e))}")
    send(f"{arg}: добавлено постов — {n}. /queue {arg}")


def on_callback(con, cb):
    kind, _, raw = (cb.get("data") or "").partition(":")
    note = "Готово"
    if kind == "pc" and raw.isdigit():
        cur = con.execute("UPDATE threads_posts SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'",
                          (int(raw),))
        note = "Пост отменён" if cur.rowcount else "Уже опубликован или отменён"
    elif kind in ("lp", "lr") and raw.isdigit():
        status = "published" if kind == "lp" else "rejected"
        con.execute("UPDATE threads_leads SET status = ?, updated_at = ? WHERE id = ? AND status = 'drafted'",
                    (status, db.utcnow(), int(raw)))
        note = "Отмечено: ответила" if kind == "lp" else "Пропущено"
    con.commit()
    tg("answerCallbackQuery", callback_query_id=cb["id"], text=note)
    msg = cb.get("message") or {}
    if msg.get("message_id"):
        tg("editMessageReplyMarkup", chat_id=config.TELEGRAM_OWNER_CHAT_ID,
           message_id=msg["message_id"], reply_markup={"inline_keyboard": []})


def on_reply(con, message):
    """Ответ на сообщение с постом из /queue заменяет текст поста."""
    target = message["reply_to_message"]["message_id"]
    text = (message.get("text") or "").strip()
    row = con.execute("SELECT * FROM threads_posts WHERE tg_message_id = ? AND status = 'scheduled'",
                      (target,)).fetchone()
    if not row:
        return send("Этот пост уже не в очереди — править нечего.")
    if not text or len(text) > config.MAX_POST_LEN:
        return send(f"Текст должен быть от 1 до {config.MAX_POST_LEN} знаков (сейчас {len(text)}).")
    con.execute("UPDATE threads_posts SET text = ? WHERE id = ?", (text, row["id"]))
    con.commit()
    send(f"Текст заменён, выйдет {_local(row['scheduled_at'])}.")


def handle(con, accounts, update):
    cb = update.get("callback_query")
    message = update.get("message") or (cb or {}).get("message") or {}
    if str((message.get("chat") or {}).get("id")) != str(config.TELEGRAM_OWNER_CHAT_ID):
        return
    if cb:
        return on_callback(con, cb)
    if message.get("reply_to_message") and not (message.get("text") or "").startswith("/"):
        return on_reply(con, message)
    parts = (message.get("text") or "").split()
    if not parts or not parts[0].startswith("/"):
        return
    cmd, arg = parts[0].split("@")[0].lower(), (parts[1] if len(parts) > 1 else "")
    if cmd in ("/start", "/help"):
        send(HELP)
    elif cmd == "/status":
        cmd_status(con, accounts)
    elif cmd == "/queue":
        cmd_queue(con, accounts, arg)
    elif cmd == "/leads":
        cmd_leads(con, accounts, arg)
    elif cmd == "/stats":
        picked = _pick(accounts, arg)
        send("\n\n".join(metrics.report(con, a) for a in picked) if picked else "Нет такого аккаунта.")
    elif cmd == "/gen":
        cmd_gen(con, accounts, arg)
    elif cmd in ("/pause", "/stop"):
        cmd_pause(con, accounts, arg, True)
    elif cmd == "/resume":
        cmd_pause(con, accounts, arg, False)
    else:
        send(HELP)


def poll(con, accounts, timeout=20):
    """Один длинный опрос Telegram. Без токена бота просто ждёт."""
    offset = int(db.get_state(con, "tg_offset", "0"))
    updates = tg("getUpdates", http_timeout=timeout + 10, offset=offset, timeout=timeout,
                 allowed_updates=["message", "callback_query"])
    for update in updates or []:
        db.set_state(con, "tg_offset", update["update_id"] + 1)  # до обработки: сбойный апдейт не зациклится
        try:
            handle(con, accounts, update)
        except Exception:
            log.exception("обработка сообщения Telegram")
    return updates is not None
