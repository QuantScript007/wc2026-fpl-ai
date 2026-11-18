"""Upload the FPL analysis to the Cloudflare Worker bot.

Run by GitHub Actions every hour (.github/workflows/fpl-bot-data.yml):

    TELEGRAM_BOT_TOKEN=... python -m stars_bot.publish   # WORKER_URL defaults to worker/deployed-url.txt

It asks the Worker which teams belong to Premium users, analyses the market and each
of those teams, and uploads ready-made message texts. The Worker just relays them.
"""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import requests

from .analysis import Analyzer
from .messages import captain_text, differentials_text, team_text

URL_FILE = Path(__file__).resolve().parent.parent / "worker" / "deployed-url.txt"


def worker_url() -> str:
    url = os.getenv("WORKER_URL") or (URL_FILE.read_text().strip() if URL_FILE.exists() else "")
    if not url:
        sys.exit("No Worker URL: run the Deploy bot workflow first (it writes worker/deployed-url.txt).")
    return url.rstrip("/")


def admin_token() -> str:
    """BOT_ADMIN_TOKEN, or the same value the Worker derives from the bot token."""
    if os.getenv("BOT_ADMIN_TOKEN"):
        return os.environ["BOT_ADMIN_TOKEN"]
    bot = os.getenv("TELEGRAM_BOT_TOKEN", "")
    return hashlib.sha256(f"fpl-ai-admin:{bot}".encode()).hexdigest() if bot else ""


def build_payload(analyzer: Analyzer, team_ids: list[int]) -> tuple[dict, list[str]]:
    data = analyzer.data()
    gw = data["gameweek"]
    payload = {"gameweek": {"next_gw": gw.get("next_gw"), "next_deadline": gw.get("next_deadline")},
               "captain_text": captain_text(data), "differentials_text": differentials_text(data), "teams": {}}
    errors = []
    for tid in team_ids:
        try:
            payload["teams"][str(tid)] = team_text(analyzer.team(int(tid)))
        except Exception as e:  # one bad team ID must not stop the rest
            errors.append(f"team {tid}: {e}")
    return payload, errors


def main() -> None:
    url, token = worker_url(), admin_token()
    if not token:
        sys.exit("Set the TELEGRAM_BOT_TOKEN secret (or BOT_ADMIN_TOKEN).")
    auth = {"authorization": f"Bearer {token}"}
    teams = requests.get(f"{url}/internal/teams", headers=auth, timeout=30)
    teams.raise_for_status()
    team_ids = teams.json()["teams"]

    payload, errors = build_payload(Analyzer(horizon=int(os.getenv("FPL_HORIZON", "5"))), team_ids)
    r = requests.post(f"{url}/internal/publish", json=payload, headers=auth, timeout=60)
    r.raise_for_status()
    print(f"Published GW{payload['gameweek']['next_gw']}: {len(payload['teams'])}/{len(team_ids)} teams, {r.json()}")
    for e in errors:
        print("::warning::" + e)


if __name__ == "__main__":
    main()
