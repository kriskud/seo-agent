"""SQLite-хранилище модуля: миграция и доступ к таблицам threads_*."""
import sqlite3
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS threads_topics (
  id INTEGER PRIMARY KEY,
  rubric TEXT NOT NULL,            -- practice | clients | stock_money | legal | building | product
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',   -- new | approved | used | parked | rejected
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS threads_posts (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER REFERENCES threads_topics(id),
  variant INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,               -- что сгенерировал агент
  final_text TEXT,                  -- что утвердила владелица
  status TEXT NOT NULL DEFAULT 'draft',
      -- draft | pending | approved | publishing | published | rejected | failed
  reject_reason TEXT,
  tg_message_id INTEGER,
  scheduled_at TEXT,
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

CREATE TABLE IF NOT EXISTS threads_replies (
  reply_id TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES threads_posts(id),
  username TEXT, text TEXT, permalink TEXT,
  created_at TEXT, notified_at TEXT
);

CREATE TABLE IF NOT EXISTS threads_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

-- Служебные флаги (пауза публикации и т. п.).
CREATE TABLE IF NOT EXISTS threads_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def connect():
    config.DATA_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(config.DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


def get_auth(con):
    return con.execute("SELECT * FROM threads_auth WHERE id = 1").fetchone()


def save_auth(con, user_id, access_token, expires_at):
    con.execute(
        """INSERT INTO threads_auth (id, user_id, access_token, expires_at, refreshed_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = excluded.user_id,
             access_token = excluded.access_token,
             expires_at = excluded.expires_at,
             refreshed_at = excluded.refreshed_at""",
        (user_id, access_token, expires_at, utcnow()),
    )
    con.commit()


def get_state(con, key, default=None):
    row = con.execute("SELECT value FROM threads_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_state(con, key, value):
    con.execute(
        "INSERT INTO threads_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    con.commit()
