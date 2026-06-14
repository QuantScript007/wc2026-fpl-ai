"""Telegram messenger -- single send() helper shared by all modules."""
import os, requests
from dotenv import load_dotenv

load_dotenv()
_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN","")
_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID","")


def send(text: str, parse_mode: str = "HTML") -> bool:
    """Send a Telegram message. Returns True on success, False when unconfigured."""
    if not _BOT_TOKEN or not _CHAT_ID:
        print(f"[Telegram] Not configured | {text[:60]}")
        return False
    resp = requests.post(
        f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage",
        data={"chat_id":_CHAT_ID,"text":text,"parse_mode":parse_mode},
        timeout=10,
    )
    resp.raise_for_status()
    return True
