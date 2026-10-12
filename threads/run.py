"""Демон Threads-агента: один процесс на все аккаунты.

Запуск:  venv/bin/python -m threads.run
Цикл: длинный опрос Telegram (команды владелицы) и раз в минуту — проход по
аккаунтам. Всё состояние в SQLite, поэтому после рестарта работа продолжается
с того же места.
"""
import logging
import signal
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from . import bot, config, db, discover, generate, llm, metrics, publish, refresh_token
from .notify import notify_owner, send

log = logging.getLogger("threads.run")

TICK_SECONDS = 60
_stop = False


def _on_signal(*_):
    global _stop
    _stop = True


def _guard(con, name, fn, *args):
    """Сбой одной задачи не должен останавливать остальные; об одной ошибке — одно сообщение в день."""
    try:
        return fn(con, *args)
    except llm.BudgetExceeded as e:
        if db.once(con, "budget_alert", datetime.now(timezone.utc).strftime("%Y-%m")):
            notify_owner(f"⚠️ {e}. Генерация и анализ остановлены до следующего месяца "
                         f"(или подними THREADS_LLM_MONTHLY_BUDGET_USD).")
    except Exception as e:
        log.exception("%s", name)
        if db.once(con, f"err:{name}", datetime.now(timezone.utc).strftime("%Y-%m-%d")):
            notify_owner(f"⚠️ {name}: {type(e).__name__}: {config.mask(str(e), config.APP_SECRET)[:300]}")


def tick(con, accounts, now=None):
    now = now or datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    if db.once(con, "refresh_day", today):
        _guard(con, "продление токенов", refresh_token.refresh_all)
        _guard(con, "очистка", discover.purge)
    for acc in accounts.values():
        if not db.is_running(con, acc):
            continue
        _guard(con, f"{acc.id}: публикация", publish.publish_due, acc, now)
        _guard(con, f"{acc.id}: генерация", generate.refill, acc, now)
        if acc.get("search") and discover.due_today(con, acc, now):
            _guard(con, f"{acc.id}: поиск", discover.discover, acc)
            _guard(con, f"{acc.id}: оценка", discover.qualify, acc)
            _guard(con, f"{acc.id}: черновики", discover.send_drafts, acc)
        if db.once(con, f"metrics_day:{acc.id}", today):
            _guard(con, f"{acc.id}: метрики", metrics.collect, acc)
    local = now.astimezone(ZoneInfo(config.TZ))
    if local.isoweekday() == 1 and local.hour >= 10 and db.once(con, "report_week", f"{local:%G-%V}"):
        active = [a for a in accounts.values() if a["status"] == "active"]
        if active:
            send("\n\n".join(metrics.report(con, a) for a in active) + "\n\n" + metrics.spend_line(con))


def main():
    config.setup_logging()
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    con = db.connect()
    accounts = config.load_accounts()
    log.info("Запуск. Аккаунты: %s", ", ".join(f"{a.id} ({a['status']})" for a in accounts.values()))
    last_tick = 0.0
    while not _stop:
        if time.monotonic() - last_tick >= TICK_SECONDS:
            last_tick = time.monotonic()
            tick(con, accounts)
        if not config.TELEGRAM_BOT_TOKEN or not bot.poll(con, accounts):
            time.sleep(10)  # нет бота или Telegram недоступен — не крутимся вхолостую
    log.info("Остановлен.")


if __name__ == "__main__":
    main()
