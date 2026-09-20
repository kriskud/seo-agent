"""Уведомления владелице в Telegram простым sendMessage, без библиотек.

Используется скриптами по таймеру (refresh_token, publish и т. д.), чтобы
ошибки не оставались тихими. Интерактивный бот живёт в bot_handlers.py.
"""
import logging

import requests

from . import config

log = logging.getLogger("threads.notify")


def notify_owner(text):
    """Шлёт сообщение владелице. Возвращает True при успехе.

    Если Telegram ещё не настроен, просто пишет сообщение в лог —
    вызывающему коду не нужно об этом заботиться.
    """
    if not (config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_OWNER_CHAT_ID):
        log.warning("Telegram не настроен, сообщение не отправлено: %s", text)
        return False
    try:
        res = requests.post(
            f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": config.TELEGRAM_OWNER_CHAT_ID, "text": text},
            timeout=30,
        )
        if res.status_code != 200:
            log.error("sendMessage: HTTP %s %s", res.status_code,
                      config.mask(res.text[:200], config.TELEGRAM_BOT_TOKEN))
            return False
        return True
    except requests.RequestException as e:
        log.error("sendMessage: %s", config.mask(str(e), config.TELEGRAM_BOT_TOKEN))
        return False
