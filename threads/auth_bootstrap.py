"""Разовое сохранение токена Threads в базу.

Запуск на сервере:  venv/bin/python -m threads.auth_bootstrap
Токен вставляется скрытым вводом и нигде, кроме базы, не сохраняется.
"""
import getpass
import sys
from datetime import datetime, timedelta, timezone

from . import config, db
from .threads_api import ThreadsApiError, ThreadsClient

ASSUMED_DAYS = 60  # у long-lived токена Threads срок жизни 60 дней


def main():
    config.setup_logging()
    token = getpass.getpass("Вставь токен из кабинета Meta (ввод невидим) и нажми Enter: ").strip()
    if not token:
        sys.exit("Пустой ввод — токен не получен.")

    client = ThreadsClient(token)
    try:
        me = client.me()
    except ThreadsApiError as e:
        sys.exit(f"Токен не подошёл: {e}\nПроверь, что скопирован целиком, и попробуй ещё раз.")

    # Короткий токен меняем на долгоживущий; долгоживущий пробуем сразу продлить.
    # Свежий долгоживущий токен Meta не продлевает (ему меньше 24 часов) —
    # тогда считаем срок 60 дней, дальше его уточнит ежедневный refresh_token.
    expires_in = None
    if config.APP_SECRET:
        try:
            res = client.exchange_long_lived(token)
            token, expires_in = res["access_token"], int(res["expires_in"])
        except ThreadsApiError:
            pass
    if expires_in is None:
        try:
            res = client.refresh(token)
            token, expires_in = res["access_token"], int(res["expires_in"])
        except ThreadsApiError:
            expires_in = ASSUMED_DAYS * 24 * 3600
            print("Meta не подтвердила срок жизни токена, считаю его долгоживущим (60 дней).")

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    con = db.connect()
    db.save_auth(con, str(me["id"]), token, expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"))

    saved = db.get_auth(con)  # читаем обратно из базы — доказательство, что строка есть
    until = db.parse_ts(saved["expires_at"])
    days = (until - datetime.now(timezone.utc)).days
    print(f"Аккаунт: @{me['username']} (id {saved['user_id']})")
    print(f"Токен сохранён в базе, действует до {until:%Y-%m-%d} (ещё {days} дн.).")


if __name__ == "__main__":
    main()
