"""FPL AI analyzer -- fetch data, score players, optimise, and publish a report.

Usage:
    python main.py                 # run now, then daily at 09:00
    python main.py --once          # run once and exit
    python main.py --team 123456   # also analyse your own FPL team
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import pandas as pd
import schedule
from dotenv import load_dotenv

from analysis.insights       import analyze_my_team, market_insights
from models.captain          import pick_captain
from models.expected_points  import score_players
from notifications.telegram  import send
from optimizer.squad         import build_optimal_squad, lineup_to_records
from scrapers.fpl            import fetch_fpl_data, fetch_manager_team

load_dotenv()
DATA_FILE = Path(__file__).parent / "data" / "player_scores.json"
TABLE_COLS = ["id", "name", "full_name", "team", "team_short", "position", "now_cost",
              "xp_next", "xp_horizon", "value", "base_xp", "form", "points_per_game",
              "total_points", "selected_by", "minutes", "goals", "assists", "xg", "xa",
              "availability", "status", "news", "next_fixture", "fixtures", "fdr_avg"]
SQUAD_COLS = ["id", "name", "team_short", "position", "now_cost", "xp_next", "xp_horizon",
              "next_fixture", "selected_by", "availability"]


def _env_int(name: str, default: int | None) -> int | None:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw.isdigit() else default


def build_report(fpl: dict, manager: dict | None = None, budget: float = 100.0,
                 horizon: int = 5) -> dict:
    """Turn raw FPL data (from fetch_fpl_data) into the dashboard payload."""
    gw = fpl["gameweek"]
    df = pd.DataFrame(fpl["players"])
    scored = score_players(df, finished_gws=gw.get("finished_gws", 0), next_gw=gw.get("next_gw"))

    captain = pick_captain(scored)
    optimal = lineup_to_records(build_optimal_squad(scored, budget=budget), SQUAD_COLS)
    report = {
        "updated":       pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
        "gameweek":      gw,
        "horizon":       horizon,
        "budget":        budget,
        "total_players": len(scored),
        "captain":       captain,
        "optimal_squad": optimal,
        "insights":      market_insights(scored),
        "players":       scored.sort_values("xp_next", ascending=False)[
                             [c for c in TABLE_COLS if c in scored.columns]
                         ].to_dict(orient="records"),
        "my_team":       None,
    }
    if manager:
        report["my_team"] = analyze_my_team(scored, manager)
    return report


def telegram_summary(report: dict) -> str:
    gw = report["gameweek"].get("next_gw")
    cap = report["captain"]
    opt = report["optimal_squad"]
    lines = [f"<b>FPL AI — GW{gw}</b>",
             f"Captain: <b>{cap['captain']}</b> ({cap['score']:.1f} xP) · VC: {cap['vice_captain']}"]
    diffs = report["insights"]["differentials"][:3]
    if diffs:
        lines.append("Differentials: " + ", ".join(f"{d['name']} ({d['selected_by']:.1f}%)" for d in diffs))
    lines.append(f"Optimal XI {opt['formation']} · £{opt['total_cost']}m · {opt['xp_next']} xP")
    mine = report.get("my_team")
    if mine:
        lines.append(f"\n<b>{mine['team_name']}</b>: captain {mine['lineup']['captain']}")
        lines.append(mine["advice"])
        for f in mine["flagged"][:5]:
            lines.append(f"⚠️ {f['name']}: {f.get('news') or 'flagged'}")
    return "\n".join(lines)


def run(team_id: int | None = None, horizon: int = 5, budget: float = 100.0,
        notify: bool = True) -> dict | None:
    """One full fetch → score → optimise → persist cycle."""
    print("[FPL] Running analysis...")
    try:
        fpl = fetch_fpl_data(horizon=horizon)
    except Exception as e:
        print(f"[FPL] Could not reach the FPL API: {e}")
        return None
    manager = None
    if team_id:
        try:
            manager = fetch_manager_team(team_id)
        except Exception as e:
            print(f"[FPL] Could not load team {team_id}: {e}")
    report = build_report(fpl, manager, budget=budget, horizon=horizon)

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(report, f, default=str)
    if notify:
        send(telegram_summary(report))
    print(f"[FPL] Done - GW{report['gameweek'].get('next_gw')} captain: {report['captain']['captain']}")
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="FPL AI analyzer")
    ap.add_argument("--once", action="store_true", help="run once and exit")
    ap.add_argument("--team", type=int, default=_env_int("FPL_TEAM_ID", None), help="your FPL team ID")
    ap.add_argument("--horizon", type=int, default=_env_int("FPL_HORIZON", 5), help="gameweeks to plan ahead")
    ap.add_argument("--budget", type=float, default=100.0, help="squad budget in £m")
    ap.add_argument("--at", default=os.getenv("FPL_RUN_AT", "09:00"), help="daily run time HH:MM")
    args = ap.parse_args()

    kwargs = dict(team_id=args.team, horizon=args.horizon, budget=args.budget)
    run(**kwargs)
    if args.once:
        return
    print(f"[FPL] Scheduled daily at {args.at}")
    schedule.every().day.at(args.at).do(run, **kwargs)
    while True:
        schedule.run_pending()
        time.sleep(60)


if __name__ == "__main__":
    main()
