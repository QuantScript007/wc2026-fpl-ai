"""Analysis helpers: your own team, transfer suggestions, and market insights."""
from __future__ import annotations

import pandas as pd

from optimizer.squad import MAX_PER_TEAM, best_xi

PLAYER_COLS = ["id", "name", "team_short", "position", "now_cost", "xp_next", "xp_horizon",
               "value", "form", "selected_by", "availability", "next_fixture", "fdr_avg",
               "news", "status"]
ROLL_THRESHOLD = 2.0   # below this horizon gain, suggest saving the free transfer


def _cols(frame: pd.DataFrame) -> list:
    return [c for c in PLAYER_COLS if c in frame.columns]


def _team_key(df: pd.DataFrame) -> str:
    return "team_id" if "team_id" in df.columns else "team"


def suggest_transfers(scored: pd.DataFrame, squad_ids: list, bank: float,
                      metric: str = "xp_horizon", top_n: int = 5, shortlist: int = 12) -> list:
    """Rank single transfers by the gain in best-XI expected points over the horizon.

    Selling prices aren't public, so current prices are used -- your in-game
    budget may be slightly lower if players rose since you bought them.
    """
    tk = _team_key(scored)
    squad = scored[scored["id"].isin(squad_ids)]
    if len(squad) < 11:
        return []
    base_xp = best_xi(squad, metric)["xp_horizon"] or 0.0
    club_counts = squad[tk].value_counts().to_dict()
    market = scored[~scored["id"].isin(squad_ids) & (scored["availability"] >= 0.75)]

    candidates = []
    for _, out in squad.iterrows():
        budget = out["now_cost"] + bank
        pool = market[(market["position"] == out["position"]) & (market["now_cost"] <= budget + 1e-9)]
        for _, inc in pool.iterrows():
            if inc[tk] != out[tk] and club_counts.get(inc[tk], 0) >= MAX_PER_TEAM:
                continue
            candidates.append((inc[metric] - out[metric], out, inc))
    candidates.sort(key=lambda t: t[0], reverse=True)

    results, seen = [], set()
    for _, out, inc in candidates[:shortlist * 3]:
        if (out["id"], inc["id"]) in seen:
            continue
        seen.add((out["id"], inc["id"]))
        new_squad = pd.concat([squad[squad["id"] != out["id"]], inc.to_frame().T])
        new_squad[metric] = new_squad[metric].astype(float)
        new_squad["xp_next"] = new_squad["xp_next"].astype(float)
        gain = (best_xi(new_squad, metric)["xp_horizon"] or 0.0) - base_xp
        results.append({
            "out": {c: out[c] for c in _cols(squad)},
            "in":  {c: inc[c] for c in _cols(squad)},
            "gain": round(float(gain), 2),
            "cost_change": round(float(inc["now_cost"] - out["now_cost"]), 1),
        })
        if len(results) >= shortlist:
            break
    results.sort(key=lambda r: r["gain"], reverse=True)
    return results[:top_n]


def analyze_my_team(scored: pd.DataFrame, manager: dict, top_n: int = 5) -> dict:
    """Best XI, captaincy, flagged players and transfer ideas for a manager's squad."""
    squad = scored[scored["id"].isin(manager["picks"])]
    missing = set(manager["picks"]) - set(squad["id"])
    lineup = best_xi(squad, "xp_next")
    transfers = suggest_transfers(scored, manager["picks"], manager["bank"], top_n=top_n)
    flagged = squad[squad["availability"] < 1.0]
    best_gain = transfers[0]["gain"] if transfers else 0.0
    advice = ("Save your free transfer -- no move gains more than "
              f"{ROLL_THRESHOLD:g} pts over the horizon." if best_gain < ROLL_THRESHOLD
              else f"Best move: {transfers[0]['out']['name']} -> {transfers[0]['in']['name']} "
                   f"(+{best_gain:.1f} pts over the horizon).")
    return {
        **{k: v for k, v in manager.items() if k != "picks"},
        "lineup": {
            **{k: v for k, v in lineup.items() if k not in ("starters", "bench")},
            "starters": lineup["starters"][_cols(squad)].to_dict(orient="records"),
            "bench": lineup["bench"][_cols(squad)].to_dict(orient="records"),
        },
        "flagged": flagged[_cols(squad)].to_dict(orient="records"),
        "transfers": transfers,
        "advice": advice,
        "missing_players": sorted(missing),
    }


def market_insights(scored: pd.DataFrame, top_n: int = 8, differential_max_owned: float = 10.0) -> dict:
    """Differentials, value picks by position, fixture ticker and transfer trends."""
    avail = scored[scored["availability"] >= 0.75]
    cols = _cols(scored)

    differentials = (avail[avail["selected_by"] < differential_max_owned]
                     .sort_values("xp_horizon", ascending=False).head(top_n))
    value = {pos: grp.sort_values("value", ascending=False).head(5)[cols].to_dict(orient="records")
             for pos, grp in avail[avail["minutes"] > 0].groupby("position")}

    ticker = []
    if "fixtures" in scored.columns:
        tk = _team_key(scored)
        for _, grp in scored.groupby(tk):
            row = grp.iloc[0]
            fx = row["fixtures"] if isinstance(row["fixtures"], list) else []
            ticker.append({
                "team": row.get("team", "?"), "team_short": row.get("team_short", "?"),
                "fixtures": fx,
                "fdr_avg": round(sum(f["difficulty"] for f in fx) / len(fx), 2) if fx else None,
                "n_fixtures": len(fx),
            })
        ticker.sort(key=lambda t: (t["fdr_avg"] is None, t["fdr_avg"] or 9, -t["n_fixtures"]))

    trend_cols = cols + [c for c in ("transfers_in_event", "transfers_out_event") if c in scored]
    rising = (scored.sort_values("transfers_in_event", ascending=False).head(top_n)[trend_cols]
              .to_dict(orient="records") if "transfers_in_event" in scored else [])
    falling = (scored.sort_values("transfers_out_event", ascending=False).head(top_n)[trend_cols]
               .to_dict(orient="records") if "transfers_out_event" in scored else [])
    injuries = (scored[(scored["availability"] < 1.0) & (scored["selected_by"] >= 5)]
                .sort_values("selected_by", ascending=False).head(15)[cols].to_dict(orient="records"))
    return {
        "differentials": differentials[cols].to_dict(orient="records"),
        "value_picks": value,
        "fixture_ticker": ticker,
        "most_transferred_in": rising,
        "most_transferred_out": falling,
        "injury_watch": injuries,
    }
