"""FPL AI Telegram bot with Telegram Stars Premium.

    python telegram_bot.py --setup --bot-username MyFplAiBot   # once: create the licence key pair
    python telegram_bot.py                                    # run the bot (long polling)

Settings come from .env (see .env.example).
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import time
from pathlib import Path

from dotenv import load_dotenv

from stars_bot.licence import generate_private_key, load_private_key, public_jwk, save_private_key

load_dotenv()
BASE = Path(__file__).parent
KEY_FILE = Path(os.getenv("LICENCE_PRIVATE_KEY", BASE / "data" / "licence_private.pem"))
DB_FILE = Path(os.getenv("STARS_BOT_DB", BASE / "data" / "stars_bot.sqlite3"))
EXT_CONFIG = BASE / "chrome-extension" / "lib" / "licence-config.js"
ALERT_EVERY = 600  # seconds between deadline-alert checks
log = logging.getLogger("stars_bot")


def write_extension_config(key, bot_username: str) -> None:
    jwk = public_jwk(key)
    EXT_CONFIG.write_text(
        "// Written by `python telegram_bot.py --setup`. Public key only -- safe to publish.\n"
        "// null = licensing not set up yet, so every feature stays unlocked.\n"
        f'export const LICENCE_PUBLIC_KEY = {{ kty: "EC", crv: "P-256", x: "{jwk["x"]}", y: "{jwk["y"]}" }};\n'
        f'export const BOT_USERNAME = "{bot_username}";\n', encoding="utf-8")


def setup(bot_username: str, force: bool) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_]{5,32}", bot_username or ""):
        raise SystemExit("--bot-username must be your bot's @username without the @")
    if KEY_FILE.exists() and not force:
        key = load_private_key(KEY_FILE)
        print(f"Using existing private key {KEY_FILE}")
    else:
        key = generate_private_key()
        save_private_key(key, KEY_FILE)
        print(f"Created private key {KEY_FILE} -- keep it secret and back it up.")
        if force:
            print("Keys issued with the old key stop working once you ship the new extension config.")
    write_extension_config(key, bot_username)
    print(f"Wrote the public key to {EXT_CONFIG.relative_to(BASE)} -- reload the extension (or publish a new version).")


def run() -> None:
    from stars_bot.analysis import Analyzer
    from stars_bot.bot import Config, StarsBot
    from stars_bot.store import Store
    from stars_bot.telegram_api import BotAPI

    if not KEY_FILE.exists():
        raise SystemExit("No licence key yet. Run: python telegram_bot.py --setup --bot-username <YourBot>")
    cfg = Config(
        price_stars=int(os.getenv("STARS_PRICE", "150")),
        premium_days=int(os.getenv("PREMIUM_DAYS", "30")),
        admin_ids={int(x) for x in re.findall(r"\d+", os.getenv("ADMIN_IDS", ""))},
        support=os.getenv("SUPPORT_CONTACT", ""),
        extension_url=os.getenv("EXTENSION_URL", ""),
    )
    api = BotAPI(os.getenv("TELEGRAM_BOT_TOKEN", ""))
    bot = StarsBot(api, Store(DB_FILE), Analyzer(horizon=int(os.getenv("FPL_HORIZON", "5"))),
                   load_private_key(KEY_FILE), cfg)
    api.call("deleteWebhook")  # long polling needs no webhook
    api.call("setMyCommands", commands=[
        {"command": c, "description": d} for c, d in [
            ("captain", "Best captain this gameweek"), ("differentials", "Low-owned picks"),
            ("team", "Save your FPL team ID"), ("myteam", "Advice for your team (Premium)"),
            ("premium", f"Get Premium — ⭐{cfg.price_stars}"), ("status", "Your plan"),
            ("key", "Chrome extension key (Premium)"), ("terms", "Terms"), ("paysupport", "Payment help")]])
    me = api.call("getMe")
    print(f"[bot] @{me['username']} running · Premium ⭐{cfg.price_stars} / {cfg.premium_days} days")

    offset, next_alerts = None, 0.0
    while True:
        try:
            updates = api.call("getUpdates", offset=offset, timeout=30,
                               allowed_updates=["message", "pre_checkout_query"])
        except Exception as e:
            log.warning("getUpdates failed: %s", e)
            time.sleep(5)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            bot.handle_update(u)
        if time.time() >= next_alerts:
            next_alerts = time.time() + ALERT_EVERY
            try:
                bot.run_alerts()
            except Exception:
                log.exception("alerts failed")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="FPL AI Telegram bot (Telegram Stars Premium)")
    ap.add_argument("--setup", action="store_true", help="create the licence key pair and extension config")
    ap.add_argument("--bot-username", default=os.getenv("BOT_USERNAME", ""))
    ap.add_argument("--new-key", action="store_true", help="with --setup: replace the existing private key")
    a = ap.parse_args()
    setup(a.bot_username, a.new_key) if a.setup else run()
