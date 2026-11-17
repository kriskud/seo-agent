"""Ежедневное продление long-lived токена Threads.

При запасе больше 30 дней ничего не делает. Если продлить не удалось и запас
меньше 10 дней — сообщает владелице в Telegram при каждом запуске, пока
проблема не решена.
"""
import logging
import sys
from datetime import datetime, timedelta, timezone

from . import config, db
from .notify import notify_owner
from .threads_api import ThreadsApiError, ThreadsClient

log = logging.getLogger("threads.refresh")

REFRESH_AHEAD_DAYS = 30
ALARM_DAYS = 10


def main():
    config.setup_logging()
    con = db.connect()
    auth = db.get_auth(con)
    if not auth:
        log.warning("Токена в базе нет — auth_bootstrap ещё не выполнялся, выходим.")
        return

    expires_at = db.parse_ts(auth["expires_at"])
    left = expires_at - datetime.now(timezone.utc)
    if left > timedelta(days=REFRESH_AHEAD_DAYS):
        log.info("Запас %s дн. — продление не требуется.", left.days)
        return

    client = ThreadsClient(auth["access_token"], auth["user_id"])
    try:
        res = client.refresh()
        new_expires = datetime.now(timezone.utc) + timedelta(seconds=int(res["expires_in"]))
        db.save_auth(con, auth["user_id"], res["access_token"],
                     new_expires.strftime("%Y-%m-%dT%H:%M:%SZ"))
        log.info("Токен продлён до %s.", f"{new_expires:%Y-%m-%d}")
    except ThreadsApiError as e:
        log.error("Продлить токен не удалось: %s", e)
        if left < timedelta(days=ALARM_DAYS):
            notify_owner(
                f"⚠️ Threads: не удалось продлить токен, он истекает {expires_at:%d.%m.%Y} "
                f"(осталось {max(left.days, 0)} дн.). Если так продолжится, получи новый токен "
                f"в кабинете Meta (threads/SETUP_META.md, шаг 7) и запусти auth_bootstrap."
            )
        sys.exit(1)


if __name__ == "__main__":
    main()
