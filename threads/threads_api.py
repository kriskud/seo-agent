"""Единственный клиент Threads API.

Все обращения к graph.threads.net в проекте идут только через этот модуль.
Ошибки 4xx не повторяются; 5xx и сетевые повторяются до 3 раз (5/30/120 c),
кроме publish — его логика дублей живёт в publish.py, поэтому retry=False.
Токены в текстах ошибок и логах маскируются.
"""
import logging
import time

import requests

from . import config, db

BASE = "https://graph.threads.net"
API = BASE + "/v1.0"
RETRY_DELAYS = (5, 30, 120)

log = logging.getLogger("threads.api")


class ThreadsApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(f"HTTP {status}: {message}")


class ThreadsClient:
    def __init__(self, access_token, user_id=None):
        self.token = access_token
        self.user_id = user_id
        self.session = requests.Session()
        if config.HTTP_PROXY:
            self.session.proxies = {"http": config.HTTP_PROXY, "https": config.HTTP_PROXY}

    @classmethod
    def from_db(cls, con):
        auth = db.get_auth(con)
        if not auth:
            raise RuntimeError("В базе нет токена Threads — сначала запусти threads.auth_bootstrap")
        return cls(auth["access_token"], auth["user_id"])

    # --- низкий уровень -------------------------------------------------

    def _mask(self, text, extra_secret=None):
        return config.mask(str(text), self.token, config.APP_SECRET, extra_secret or "")

    def _request(self, method, url, params=None, data=None, retry=True, token=None):
        tok = token or self.token
        params = dict(params or {})
        if data is not None:
            data = {**data, "access_token": tok}
        else:
            params["access_token"] = tok
        attempts = 1 + (len(RETRY_DELAYS) if retry else 0)
        err = None
        for attempt in range(attempts):
            try:
                res = self.session.request(method, url, params=params, data=data, timeout=30)
            except requests.RequestException as e:
                err = ThreadsApiError(0, self._mask(e, token))
            else:
                if res.status_code < 400:
                    return res.json()
                err = ThreadsApiError(res.status_code, self._mask(res.text[:500], token))
                if res.status_code < 500:
                    raise err  # 4xx не повторяем
            if attempt < attempts - 1:
                log.warning("%s %s: %s — повтор через %s c", method, url, err, RETRY_DELAYS[attempt])
                time.sleep(RETRY_DELAYS[attempt])
        raise err

    # --- токены ---------------------------------------------------------

    def exchange_long_lived(self, short_token):
        return self._request("GET", f"{BASE}/access_token", params={
            "grant_type": "th_exchange_token",
            "client_secret": config.APP_SECRET,
        }, token=short_token)

    def refresh(self, token=None):
        return self._request("GET", f"{BASE}/refresh_access_token", params={
            "grant_type": "th_refresh_token",
        }, token=token)

    # --- аккаунт и посты ------------------------------------------------

    def me(self):
        return self._request("GET", f"{API}/me", params={"fields": "id,username"})

    def create_text_container(self, text):
        res = self._request("POST", f"{API}/{self.user_id}/threads",
                            data={"media_type": "TEXT", "text": text})
        return res["id"]

    def container_status(self, container_id):
        return self._request("GET", f"{API}/{container_id}",
                             params={"fields": "status,error_message"})

    def publish(self, container_id):
        res = self._request("POST", f"{API}/{self.user_id}/threads_publish",
                            data={"creation_id": container_id}, retry=False)
        return res["id"]

    def recent_posts(self, limit=25):
        res = self._request("GET", f"{API}/{self.user_id}/threads", params={
            "fields": "id,text,permalink,timestamp", "limit": limit,
        })
        return res.get("data", [])

    def post_insights(self, post_id):
        res = self._request("GET", f"{API}/{post_id}/insights", params={
            "metric": "views,likes,replies,reposts,quotes",
        })
        out = {}
        for item in res.get("data", []):
            if "total_value" in item:
                out[item["name"]] = item["total_value"].get("value")
            elif item.get("values"):
                out[item["name"]] = item["values"][0].get("value")
        return out

    def post_replies(self, post_id):
        res = self._request("GET", f"{API}/{post_id}/replies", params={
            "fields": "id,text,username,permalink,timestamp",
        })
        return res.get("data", [])

    def publishing_limit(self):
        res = self._request("GET", f"{API}/{self.user_id}/threads_publishing_limit",
                            params={"fields": "quota_usage,config"})
        data = res.get("data", [])
        return data[0] if data else {}
