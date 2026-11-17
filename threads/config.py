"""Конфигурация Threads-модуля: env-файл, пути, константы."""
import logging
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # корень seo-agent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "threads.db"
CONTENT_DIR = Path(__file__).resolve().parent / "content"

ENV_FILE = Path(os.environ.get("THREADS_ENV_FILE", "/etc/seo-agent/threads.env"))


def _load_env_file():
    # Как lib.mjs в основном проекте: файл не перекрывает уже выставленные переменные,
    # поэтому EnvironmentFile= в systemd и ручной запуск работают одинаково.
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file()

APP_ID = os.environ.get("THREADS_APP_ID", "")
APP_SECRET = os.environ.get("THREADS_APP_SECRET", "")
HTTP_PROXY = os.environ.get("THREADS_HTTP_PROXY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
LLM_MODEL = os.environ.get("THREADS_LLM_MODEL", "claude-sonnet-5")
POSTS_PER_DAY = int(os.environ.get("THREADS_POSTS_PER_DAY", "1"))
POST_SLOTS = [s.strip() for s in os.environ.get("THREADS_POST_SLOTS", "10:30,19:30").split(",") if s.strip()]
POST_WEEKDAYS = [int(d) for d in os.environ.get("THREADS_POST_WEEKDAYS", "1,2,3,4,5").split(",") if d.strip()]
TZ = os.environ.get("THREADS_TZ", "Europe/Moscow")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_OWNER_CHAT_ID = os.environ.get("TELEGRAM_OWNER_CHAT_ID", "")

# Порог похожести нового поста на старые (0..1), см. validate.py.
SIMILARITY_THRESHOLD = float(os.environ.get("THREADS_SIMILARITY_THRESHOLD", "0.55"))

MAX_POST_LEN = 500


def mask(text, *secrets):
    """Маскирует секреты в строке перед логом или сообщением об ошибке."""
    for s in secrets:
        if s and len(s) >= 8:
            text = text.replace(s, s[:4] + "…" + s[-4:])
    return text


def setup_logging():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
