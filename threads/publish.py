"""Публикация постов из очереди. Главная забота — не выпустить один пост дважды.

Перед обращением к Meta пост переводится в 'publishing'. Если процесс упал или
сеть оборвалась и исход неизвестен, пост ищется среди последних постов аккаунта:
нашёлся — значит вышел; не нашёлся — возвращается в очередь.
"""
import logging
import time
from datetime import datetime, timedelta, timezone

from . import db, schedule
from .notify import notify_owner
from .threads_api import NoTokenError, ThreadsApiError, ThreadsClient

log = logging.getLogger("threads.publish")

MAX_ATTEMPTS = 3
STALE_HOURS = 3           # пост опоздал сильнее (сервер лежал) — переносим, а не шлём пачкой
CONTAINER_WAIT_S = 30


def _find_published(client, text):
    for item in client.recent_posts():
        if (item.get("text") or "").strip() == text.strip():
            return item
    return None


def _mark_published(con, post_id, threads_id, permalink):
    con.execute("UPDATE threads_posts SET status = 'published', threads_post_id = ?, permalink = ?, "
                "published_at = ?, error = NULL WHERE id = ?",
                (threads_id, permalink, db.utcnow(), post_id))
    con.commit()


def _fail(con, account, post, error, now=None):
    attempts = post["attempts"] + 1
    if attempts >= MAX_ATTEMPTS:
        con.execute("UPDATE threads_posts SET status = 'failed', attempts = ?, error = ? WHERE id = ?",
                    (attempts, str(error)[:500], post["id"]))
        con.commit()
        notify_owner(f"⚠️ {account.id}: пост №{post['id']} не опубликован после {attempts} попыток.\n{error}")
    else:
        # Контейнер сбрасываем: следующая попытка создаст новый.
        con.execute("UPDATE threads_posts SET status = 'scheduled', attempts = ?, error = ?, "
                    "container_id = NULL, scheduled_at = ? WHERE id = ?",
                    (attempts, str(error)[:500],
                     db.fmt_ts((now or datetime.now(timezone.utc)) + timedelta(minutes=15 * attempts)), post["id"]))
        con.commit()


def _alert_auth(con, account, error):
    if db.once(con, f"auth_alert:{account.id}", datetime.now(timezone.utc).strftime("%Y-%m-%d")):
        notify_owner(f"⚠️ {account.id}: Threads не принимает токен — публикации стоят.\n{error}\n"
                     f"Получи новый токен (threads/SETUP_META.md, шаг 7) и запусти auth_bootstrap {account.id}.")


def reconcile(con, account, client):
    """Посты, застрявшие в 'publishing' после падения: вышли или нет?"""
    for post in con.execute("SELECT * FROM threads_posts WHERE account = ? AND status = 'publishing'",
                            (account.id,)).fetchall():
        found = _find_published(client, post["text"])
        if found:
            _mark_published(con, post["id"], found["id"], found.get("permalink"))
            log.info("%s: пост №%s уже был опубликован, отмечен", account.id, post["id"])
        else:
            _fail(con, account, post, "процесс прервался во время публикации")


def publish_due(con, account, now=None, client=None, sleep=time.sleep):
    """Публикует посты, чьё время пришло. Возвращает число опубликованных."""
    now = now or datetime.now(timezone.utc)
    stuck = con.execute("SELECT 1 FROM threads_posts WHERE account = ? AND status = 'publishing'",
                        (account.id,)).fetchone()
    due = con.execute(
        "SELECT * FROM threads_posts WHERE account = ? AND status = 'scheduled' AND scheduled_at <= ? "
        "ORDER BY scheduled_at", (account.id, db.fmt_ts(now))).fetchall()
    if not due and not stuck:
        return 0
    try:
        client = client or ThreadsClient.from_db(con, account.id)
        reconcile(con, account, client)
    except NoTokenError as e:
        _alert_auth(con, account, e)
        return 0
    except ThreadsApiError as e:
        if e.auth_failed:
            _alert_auth(con, account, e)
        else:
            log.warning("%s: Threads недоступен: %s", account.id, e)
        return 0

    done = 0
    for post in due:
        if now - db.parse_ts(post["scheduled_at"]) > timedelta(hours=STALE_HOURS) and post["attempts"] == 0:
            when = schedule.move_to_next_slot(con, account, post["id"], now)
            log.info("%s: пост №%s опоздал, перенесён на %s", account.id, post["id"], when)
            continue
        if done:  # не больше одного поста за проход: остальные выйдут следующими проходами
            break
        # Захват: только один проход может перевести пост в publishing.
        cur = con.execute("UPDATE threads_posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'",
                          (post["id"],))
        con.commit()
        if cur.rowcount != 1:
            continue
        try:
            container = client.create_text_container(post["text"])
            con.execute("UPDATE threads_posts SET container_id = ? WHERE id = ?", (container, post["id"]))
            con.commit()
            waited = 0
            while waited < CONTAINER_WAIT_S:
                status = client.container_status(container)
                if status.get("status") == "FINISHED":
                    break
                if status.get("status") in ("ERROR", "EXPIRED"):
                    raise ThreadsApiError(400, f"контейнер: {status.get('error_message') or status['status']}")
                sleep(3)
                waited += 3
            threads_id = client.publish(container)
        except ThreadsApiError as e:
            if e.auth_failed:
                con.execute("UPDATE threads_posts SET status = 'scheduled', container_id = NULL WHERE id = ?",
                            (post["id"],))
                con.commit()
                _alert_auth(con, account, e)
                return done
            # Исход publish неизвестен (сеть, 5xx) — пост мог выйти. Проверяем, прежде чем повторять.
            try:
                found = _find_published(client, post["text"])
            except ThreadsApiError:
                log.warning("%s: пост №%s — исход неизвестен, проверим на следующем проходе",
                            account.id, post["id"])
                return done  # остаётся в publishing, разберёт reconcile
            if found:
                _mark_published(con, post["id"], found["id"], found.get("permalink"))
                done += 1
            else:
                log.error("%s: пост №%s не опубликован: %s", account.id, post["id"], e)
                _fail(con, account, post, e, now)
            continue
        permalink = None
        try:
            permalink = client.post_info(threads_id).get("permalink")
        except ThreadsApiError:
            pass
        _mark_published(con, post["id"], threads_id, permalink)
        log.info("%s: опубликован пост №%s", account.id, post["id"])
        done += 1
    return done
