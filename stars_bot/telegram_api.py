"""Minimal Telegram Bot API client (just requests, no framework)."""
from __future__ import annotations

import requests


class TelegramError(RuntimeError):
    pass


class BotAPI:
    def __init__(self, token: str, session: requests.Session | None = None):
        if not token:
            raise ValueError("TELEGRAM_BOT_TOKEN is not set")
        self.base = f"https://api.telegram.org/bot{token}"
        self.http = session or requests.Session()

    def call(self, method: str, **params):
        params = {k: v for k, v in params.items() if v is not None}
        # long polling (getUpdates timeout=30) needs a longer HTTP timeout
        http_timeout = 20 + int(params.get("timeout", 0) or 0)
        resp = self.http.post(f"{self.base}/{method}", json=params, timeout=http_timeout)
        try:
            data = resp.json()
        except ValueError:
            resp.raise_for_status()
            raise TelegramError(f"{method}: invalid response")
        if not data.get("ok"):
            raise TelegramError(f"{method}: {data.get('description', 'failed')}")
        return data["result"]

    def send(self, chat_id: int, text: str, **kw):
        return self.call("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML",
                         link_preview_options={"is_disabled": True}, **kw)
