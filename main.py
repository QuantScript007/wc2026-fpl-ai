"""FPL AI bot -- fetches data daily at 09:00."""
import json, time, schedule
import pandas as pd
from pathlib import Path
from dotenv import load_dotenv

from scrapers.fpl           import fetch_player_data
from models.captain         import pick_captain
from optimizer.lineup       import build_best_xi
from notifications.telegram import send

load_dotenv()
DATA_FILE = Path("data/player_scores.json")


def run() -> None:
    """One full FPL data-fetch, score, and persist cycle."""
    print("[FPL] Running job...")
    players = fetch_player_data()
    if not players:
        return
    df       = pd.DataFrame(players)
    captain  = pick_captain(df)
    xi, subs = build_best_xi(df)
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated":       pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
        "captain":       captain,
        "total_players": len(df),
        "top_players":   df.sort_values("score", ascending=False).head(200).to_dict(orient="records"),
        "xi":            xi.to_dict(orient="records"),
        "subs":          subs.to_dict(orient="records"),
    }
    with open(DATA_FILE, "w") as f:
        json.dump(payload, f, default=str)
    send(f"[FPL] Captain: {captain['captain']} | {payload['updated']}")
    print(f"[FPL] Done - captain: {captain['captain']}")


if __name__ == "__main__":
    print("[FPL] Bot started - daily at 09:00")
    run()
    schedule.every().day.at("09:00").do(run)
    while True:
        schedule.run_pending()
        time.sleep(60)
