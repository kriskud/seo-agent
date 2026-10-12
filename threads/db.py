"""SQLite-хранилище модуля: миграция и доступ к таблицам threads_*."""
import sqlite3
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS threads_posts (
  id INTEGER PRIMARY KEY,
  account TEXT,
  rubric TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
      -- scheduled | publishing | published | cancelled | failed
  slot_key TEXT,                    -- «ГГГГ-ММ-ДД ЧЧ:ММ» в поясе аккаунта: один слот — один пост
  scheduled_at TEXT,
  tg_message_id INTEGER,
  container_id TEXT,
  threads_post_id TEXT,
  permalink TEXT,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads_metrics (
  post_id INTEGER NOT NULL REFERENCES threads_posts(id),
  collected_at TEXT NOT NULL,
  views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, quotes INTEGER,
  PRIMARY KEY (post_id, collected_at)
);

CREATE TABLE IF NOT EXISTS threads_tokens (
  account TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT,
  access_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

-- Найденные чужие обсуждения. Храним только ссылку, ник и сниппет из поиска.
CREATE TABLE IF NOT EXISTS threads_leads (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT, title TEXT, snippet TEXT, query TEXT,
  score INTEGER, reason TEXT, draft TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
      -- discovered | drafted | published | rejected
  tg_message_id INTEGER,
  found_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account, url)
);

CREATE TABLE IF NOT EXISTS threads_llm_usage (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  account TEXT, purpose TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL
);

-- Служебные флаги (пауза, отметки «сегодня уже делали» и т. п.).
CREATE TABLE IF NOT EXISTS threads_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# Колонки, которых не было в схеме фазы 1 (таблица могла быть уже создана на сервере).
_ADDED_COLUMNS = {"threads_posts": {"account": "TEXT", "rubric": "TEXT", "slot_key": "TEXT"}}

TS = "%Y-%m-%dT%H:%M:%SZ"


def utcnow():
    return datetime.now(timezone.utc).strftime(TS)


def fmt_ts(dt):
    return dt.astimezone(timezone.utc).strftime(TS)


def parse_ts(value):
    return datetime.strptime(value, TS).replace(tzinfo=timezone.utc)


def connect(path=None):
    config.DATA_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(path or config.DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    for table, columns in _ADDED_COLUMNS.items():
        have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        for name, kind in columns.items():
            if name not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS threads_posts_slot ON threads_posts(account, slot_key) "
                "WHERE slot_key IS NOT NULL AND status IN ('scheduled','publishing','published')")
    con.commit()
    return con


def get_auth(con, account):
    return con.execute("SELECT * FROM threads_tokens WHERE account = ?", (account,)).fetchone()


def save_auth(con, account, user_id, access_token, expires_at, username=None):
    con.execute(
        """INSERT INTO threads_tokens (account, user_id, username, access_token, expires_at, refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET
             user_id = excluded.user_id,
             username = COALESCE(excluded.username, threads_tokens.username),
             access_token = excluded.access_token,
             expires_at = excluded.expires_at,
             refreshed_at = excluded.refreshed_at""",
        (account, user_id, username, access_token, expires_at, utcnow()),
    )
    con.commit()


def get_state(con, key, default=None):
    row = con.execute("SELECT value FROM threads_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_state(con, key, value):
    con.execute(
        "INSERT INTO threads_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )
    con.commit()


def once(con, key, value):
    """True, если отметка key ещё не равна value; тут же её ставит. Для «раз в день»."""
    if get_state(con, key) == str(value):
        return False
    set_state(con, key, value)
    return True


def is_running(con, account):
    """Работает ли автоматика аккаунта: статус в конфиге + паузы из Telegram."""
    if account["status"] != "active" or get_state(con, "paused_all") == "1":
        return False
    return get_state(con, f"paused:{account.id}") != "1"
