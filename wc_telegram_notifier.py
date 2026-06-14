"""WC2026 Telegram notifier -- polls ESPN every 60 s for match state changes."""
import json, time
from pathlib import Path
from datetime import datetime, timezone

from scrapers.espn           import fetch_fixtures
from notifications.telegram  import send

NOTIF_LOG = Path("data/notif_sent.json")


def _sent_keys() -> set:
    if not NOTIF_LOG.exists():
        return set()
    return set(json.loads(NOTIF_LOG.read_text())["sent"])


def _mark_sent(key: str) -> None:
    keys = _sent_keys()
    keys.add(key)
    NOTIF_LOG.parent.mkdir(parents=True, exist_ok=True)
    NOTIF_LOG.write_text(json.dumps({"sent": list(keys)}))


def _check_and_notify(fixture: dict, now: datetime) -> None:
    home = fixture["home_team"]
    away = fixture["away_team"]
    mk   = f"{home}_vs_{away}"

    if fixture["status_state"] == "pre" and fixture.get("date"):
        try:
            ko   = datetime.fromisoformat(fixture["date"].replace("Z", "+00:00"))
            mins = (ko - now).total_seconds() / 60
            if 55 <= mins <= 65 and f"pre_{mk}" not in _sent_keys():
                send(f"\u26bd <b>UPCOMING:</b> {home} vs {away} ~60 min | {fixture['venue']} #WC2026")
                _mark_sent(f"pre_{mk}")
        except Exception:
            pass

    if fixture["status_state"] == "in" and f"ko_{mk}" not in _sent_keys():
        send(f"\U0001f7e2 <b>KICK OFF!</b> {home} vs {away} | {fixture['venue']} #WC2026")
        _mark_sent(f"ko_{mk}")

    if fixture["status_state"] == "post" and f"ft_{mk}" not in _sent_keys():
        hs, as_ = fixture.get("home_score", ""), fixture.get("away_score", "")
        send(f"\U0001f514 <b>FT:</b> {home} {hs} - {as_} {away} #WC2026")
        _mark_sent(f"ft_{mk}")


def monitor() -> None:
    print("[TG] Notifier started...")
    while True:
        try:
            now      = datetime.now(timezone.utc)
            fixtures = fetch_fixtures(live=True)
            for fix in fixtures:
                _check_and_notify(fix, now)
        except Exception as e:
            print(f"[TG] Monitor error: {e}")
        time.sleep(60)


if __name__ == "__main__":
    send("\u26bd <b>WC2026 Telegram Bot LIVE!</b>")
    monitor()
