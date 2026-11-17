"""Продление long-lived токенов Threads, по всем аккаунтам.

При запасе больше 30 дней ничего не делает. Если продлить не удалось и запас
меньше 10 дней — сообщает владелице в Telegram при каждом запуске, пока
проблема не решена.
"""
import logging
from datetime import datetime, timedelta, timezone

from . import config, db
from .notify import notify_owner
from .threads_api import ThreadsApiError, ThreadsClient

log = logging.getLogger("threads.refresh")

REFRESH_AHEAD_DAYS = 30
ALARM_DAYS = 10


def refresh_all(con):
    for auth in con.execute("SELECT * FROM threads_tokens").fetchall():
        account = auth["account"]
        expires_at = db.parse_ts(auth["expires_at"])
        left = expires_at - datetime.now(timezone.utc)
        if left > timedelta(days=REFRESH_AHEAD_DAYS):
            continue
        client = ThreadsClient(auth["access_token"], auth["user_id"])
        try:
            res = client.refresh()
            new_expires = datetime.now(timezone.utc) + timedelta(seconds=int(res["expires_in"]))
            db.save_auth(con, account, auth["user_id"], res["access_token"], db.fmt_ts(new_expires))
            log.info("%s: токен продлён до %s.", account, f"{new_expires:%Y-%m-%d}")
        except ThreadsApiError as e:
            log.error("%s: продлить токен не удалось: %s", account, e)
            if left < timedelta(days=ALARM_DAYS):
                notify_owner(
                    f"⚠️ {account}: не удалось продлить токен Threads, он истекает "
                    f"{expires_at:%d.%m.%Y} (осталось {max(left.days, 0)} дн.). Получи новый токен "
                    f"в кабинете Meta (threads/SETUP_META.md, шаг 7) и запусти auth_bootstrap {account}."
                )


if __name__ == "__main__":
    config.setup_logging()
    refresh_all(db.connect())
