"""Сбор метрик опубликованных постов и текстовый отчёт."""
import html
import logging
from datetime import datetime, timedelta, timezone

from . import db, llm
from .threads_api import NoTokenError, ThreadsApiError, ThreadsClient

log = logging.getLogger("threads.metrics")

TRACK_DAYS = 14   # дольше пост метрики почти не набирает


def collect(con, account, client=None):
    since = db.fmt_ts(datetime.now(timezone.utc) - timedelta(days=TRACK_DAYS))
    posts = con.execute(
        "SELECT id, threads_post_id FROM threads_posts WHERE account = ? AND status = 'published' "
        "AND threads_post_id IS NOT NULL AND published_at >= ?", (account.id, since)).fetchall()
    if not posts:
        return 0
    try:
        client = client or ThreadsClient.from_db(con, account.id)
    except NoTokenError:
        return 0
    n = 0
    for post in posts:
        try:
            m = client.post_insights(post["threads_post_id"])
        except ThreadsApiError as e:
            log.warning("%s: метрики поста №%s: %s", account.id, post["id"], e)
            continue
        con.execute(
            "INSERT OR REPLACE INTO threads_metrics (post_id, collected_at, views, likes, replies, reposts, quotes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (post["id"], db.utcnow(), m.get("views"), m.get("likes"), m.get("replies"),
             m.get("reposts"), m.get("quotes")))
        n += 1
    con.commit()
    return n


def report(con, account, days=7):
    """HTML-отчёт за days дней: посты, охват, лучшие посты по рубрикам, обсуждения."""
    since = db.fmt_ts(datetime.now(timezone.utc) - timedelta(days=days))
    # Последний замер по каждому посту.
    rows = con.execute(
        """SELECT p.id, p.rubric, p.text, p.permalink,
                  COALESCE(m.views, 0) AS views, COALESCE(m.likes, 0) AS likes,
                  COALESCE(m.replies, 0) AS replies
           FROM threads_posts p
           LEFT JOIN threads_metrics m ON m.post_id = p.id AND m.collected_at =
                (SELECT MAX(collected_at) FROM threads_metrics WHERE post_id = p.id)
           WHERE p.account = ? AND p.status = 'published' AND p.published_at >= ?
           ORDER BY views DESC""", (account.id, since)).fetchall()
    leads = {r["status"]: r["n"] for r in con.execute(
        "SELECT status, COUNT(*) AS n FROM threads_leads WHERE account = ? AND found_at >= ? GROUP BY status",
        (account.id, since))}
    e = html.escape
    lines = [f"<b>{e(account.id)}</b> — {days} дн.",
             f"Постов: {len(rows)} · просмотров: {sum(r['views'] for r in rows)} · "
             f"лайков: {sum(r['likes'] for r in rows)} · ответов: {sum(r['replies'] for r in rows)}"]
    by_rubric = {}
    for r in rows:
        by_rubric.setdefault(r["rubric"] or "—", []).append(r["views"])
    if by_rubric:
        lines.append("По рубрикам (в среднем просмотров): " + ", ".join(
            f"{k} {sum(v) // len(v)} ({len(v)})" for k, v in sorted(by_rubric.items())))
    for r in rows[:3]:
        lines.append(f"• {r['views']} 👁 {r['likes']} ♥ {r['replies']} 💬 — {e(r['text'][:80])}")
    lines.append(f"Обсуждения: найдено {sum(leads.values())}, с черновиком {leads.get('drafted', 0)}, "
                 f"отвечено {leads.get('published', 0)}, отклонено {leads.get('rejected', 0)}")
    if len(rows) < 10:
        lines.append("<i>Постов мало — сравнивать рубрики и время пока рано.</i>")
    return "\n".join(lines)


def spend_line(con):
    return f"AI за месяц: ${llm.month_spend(con):.2f}"
