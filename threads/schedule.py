"""Слоты публикаций аккаунта и раскладка постов по ним."""
import hashlib
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import db

JITTER_MIN = 15       # ± минут к слоту, чтобы посты не выходили минута в минуту
LEAD_MIN = 10         # ближе этого к «сейчас» слот уже не занимаем
OCCUPYING = ("scheduled", "publishing", "published")


def _jitter(account_id, slot_key):
    h = int(hashlib.sha1(f"{account_id}|{slot_key}".encode()).hexdigest(), 16)
    return h % (2 * JITTER_MIN + 1) - JITTER_MIN


def upcoming_slots(account, now, days):
    """Будущие слоты на days дней: [(slot_key, момент в UTC)], по возрастанию.

    Если слотов в конфиге больше, чем постов в день, они чередуются по дням.
    """
    tz = ZoneInfo(account["timezone"])
    slots = sorted(account["slots"])
    per_day = min(int(account["posts_per_day"]), len(slots))
    today = now.astimezone(tz).date()
    out = []
    for offset in range(days + 1):
        day = today + timedelta(days=offset)
        if day.isoweekday() not in account["weekdays"] or per_day <= 0:
            continue
        start = day.toordinal() % len(slots)
        for slot in sorted(slots[(start + i) % len(slots)] for i in range(per_day)):
            key = f"{day:%Y-%m-%d} {slot}"
            hh, mm = map(int, slot.split(":"))
            local = datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)
            when = (local + timedelta(minutes=_jitter(account.id, key))).astimezone(timezone.utc)
            if now + timedelta(minutes=LEAD_MIN) < when <= now + timedelta(days=days):
                out.append((key, when))
    return sorted(out, key=lambda s: s[1])


def free_slots(con, account, now, days):
    taken = {r["slot_key"] for r in con.execute(
        f"SELECT slot_key FROM threads_posts WHERE account = ? AND status IN {OCCUPYING}", (account.id,))}
    return [s for s in upcoming_slots(account, now, days) if s[0] not in taken]


def move_to_next_slot(con, account, post_id, now):
    """Переносит пост в ближайший свободный слот (после простоя сервера или ошибки).

    Возвращает новое время или None, если свободных слотов на неделю вперёд нет.
    """
    free = free_slots(con, account, now, 7)
    if not free:
        return None
    key, when = free[0]
    con.execute("UPDATE threads_posts SET slot_key = ?, scheduled_at = ?, status = 'scheduled' WHERE id = ?",
                (key, db.fmt_ts(when), post_id))
    con.commit()
    return when
