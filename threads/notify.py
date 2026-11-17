"""Сообщения владелице в Telegram через Bot API, без библиотек.

Если Telegram ещё не настроен, сообщение уходит в лог — вызывающему коду
не нужно об этом заботиться.
"""
import html
import logging

import requests

from . import config

log = logging.getLogger("threads.notify")


def tg(method, http_timeout=30, **payload):
    """Вызов Bot API. Возвращает result или None при ошибке."""
    if not (config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_OWNER_CHAT_ID):
        return None
    try:
        res = requests.post(f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/{method}",
                            json=payload, timeout=http_timeout)
        if res.status_code != 200:
            log.error("%s: HTTP %s %s", method, res.status_code,
                      config.mask(res.text[:200], config.TELEGRAM_BOT_TOKEN))
            return None
        return res.json().get("result")
    except requests.RequestException as e:
        log.error("%s: %s", method, config.mask(str(e), config.TELEGRAM_BOT_TOKEN))
        return None


def send(text, buttons=None):
    """Шлёт HTML-сообщение владелице. buttons — [[(подпись, callback_data), ...], ...].

    Возвращает message_id или None.
    """
    if not (config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_OWNER_CHAT_ID):
        log.warning("Telegram не настроен, сообщение не отправлено: %s", text)
        return None
    payload = {"chat_id": config.TELEGRAM_OWNER_CHAT_ID, "text": text[:4096], "parse_mode": "HTML",
               "link_preview_options": {"is_disabled": True}}
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": [
            [{"text": label, "callback_data": data} for label, data in row] for row in buttons]}
    res = tg("sendMessage", **payload)
    return res["message_id"] if res else None


def notify_owner(text):
    """Простое текстовое уведомление. Возвращает True при успехе."""
    return send(html.escape(text)) is not None
