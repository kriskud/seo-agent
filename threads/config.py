"""Конфигурация Threads-модуля: env-файл, пути, константы, аккаунты."""
import json
import logging
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # корень seo-agent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "threads.db"
ACCOUNTS_DIR = Path(__file__).resolve().parent / "accounts"

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
# Потолок расходов на генерацию и анализ за календарный месяц, на все аккаунты.
LLM_MONTHLY_BUDGET_USD = float(os.environ.get("THREADS_LLM_MONTHLY_BUDGET_USD", "15"))
SERPER_API_KEY = os.environ.get("SERPER_API_KEY", "")
# Часовой пояс владелицы: еженедельный отчёт и время в сообщениях бота.
TZ = os.environ.get("THREADS_TZ", "Europe/Moscow")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_OWNER_CHAT_ID = os.environ.get("TELEGRAM_OWNER_CHAT_ID", "")

# Порог похожести нового поста на старые (0..1), см. generate.validate.
SIMILARITY_THRESHOLD = float(os.environ.get("THREADS_SIMILARITY_THRESHOLD", "0.6"))
# На сколько дней вперёд держим очередь заполненной.
QUEUE_DAYS = int(os.environ.get("THREADS_QUEUE_DAYS", "3"))

MAX_POST_LEN = 500
MIN_EXAMPLES = 5

ACCOUNT_STATUSES = ("active", "paused", "draft")
_REQUIRED = ("brand", "language", "status", "website_url", "timezone", "audience",
             "posts_per_day", "slots", "weekdays")


class Account:
    """Один Threads-аккаунт: account.json + voice.md, facts.md, examples.md, banned.txt."""

    def __init__(self, path):
        self.dir = Path(path)
        self.id = self.dir.name
        self.data = json.loads((self.dir / "account.json").read_text(encoding="utf-8"))
        missing = [k for k in _REQUIRED if k not in self.data]
        if missing:
            raise ValueError(f"{self.id}/account.json: нет полей {', '.join(missing)}")
        if self.data["status"] not in ACCOUNT_STATUSES:
            raise ValueError(f"{self.id}/account.json: status должен быть одним из {ACCOUNT_STATUSES}")

    def __getitem__(self, key):
        return self.data[key]

    def get(self, key, default=None):
        return self.data.get(key, default)

    def _read(self, name):
        p = self.dir / name
        return p.read_text(encoding="utf-8").strip() if p.is_file() else ""

    @property
    def voice(self):
        return self._read("voice.md")

    @property
    def facts(self):
        return self._read("facts.md")

    @property
    def examples(self):
        return [p.strip() for p in self._read("examples.md").split("\n---") if p.strip()]

    @property
    def banned(self):
        return [l.strip().lower() for l in self._read("banned.txt").splitlines()
                if l.strip() and not l.startswith("#")]

    def tracked_url(self):
        """Адрес сайта с UTM-метками аккаунта — для ссылки в био и в ответах."""
        params = self.get("tracking") or {}
        if not params:
            return self["website_url"]
        sep = "&" if "?" in self["website_url"] else "?"
        return self["website_url"] + sep + "&".join(f"{k}={v}" for k, v in params.items())


def load_accounts():
    """Все аккаунты из threads/accounts/ (каталоги с account.json, кроме _шаблонов)."""
    out = {}
    for p in sorted(ACCOUNTS_DIR.iterdir()):
        if p.is_dir() and not p.name.startswith("_") and (p / "account.json").is_file():
            out[p.name] = Account(p)
    return out


def mask(text, *secrets):
    """Маскирует секреты в строке перед логом или сообщением об ошибке."""
    for s in secrets:
        if s and len(s) >= 8:
            text = text.replace(s, s[:4] + "…" + s[-4:])
    return text


def setup_logging():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
