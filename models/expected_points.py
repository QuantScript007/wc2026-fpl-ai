"""Expected-points model for FPL players.

Blends four signals into a per-match points estimate, then scales it by
availability and the difficulty of each upcoming fixture:

  * an xG/xA "underlying stats" model using FPL's scoring rules per position
  * recent form (FPL's rolling 30-day points per match)
  * season points-per-game
  * FPL's own ep_next estimate

The result is transparent and cheap to compute -- every column it adds is
shown on the dashboard so you can see *why* a player ranks where he does.
"""
from __future__ import annotations

import math
import pandas as pd

GOAL_PTS  = {"GKP": 6, "DEF": 6, "MID": 5, "FWD": 4}
CS_PTS    = {"GKP": 4, "DEF": 4, "MID": 1, "FWD": 0}
ASSIST_PTS = 3

# Multiplier applied to a player's base points for a fixture of given FDR (1 easy .. 5 hard)
FDR_MULT  = {1: 1.20, 2: 1.10, 3: 1.00, 4: 0.88, 5: 0.76}
HOME_BONUS = 0.04

# Blend weights for the per-match estimate
WEIGHTS = {"underlying": 0.35, "form": 0.20, "ppg": 0.20, "ep_next": 0.25}

# Below this many minutes the per-90 stats are too noisy to trust fully
MIN_SAMPLE_MINUTES = 450

_DEFAULTS = {
    "position": "MID", "now_cost": 5.0, "minutes": 0, "starts": 0, "goals": 0,
    "assists": 0, "xg": 0.0, "xa": 0.0, "xgc": 0.0, "bonus": 0, "form": 0.0,
    "points_per_game": 0.0, "ep_next": 0.0, "status": "a", "chance_of_playing": None,
    "selected_by": 0.0, "total_points": 0,
}


def availability(status: str, chance: float | None) -> float:
    """Probability the player is available for the next gameweek (0..1)."""
    if chance is not None and not (isinstance(chance, float) and math.isnan(chance)):
        return max(0.0, min(1.0, float(chance) / 100.0))
    return {"a": 1.0, "d": 0.5}.get(status, 0.0)  # i/s/u/n -> 0


def _underlying_per_match(row, finished_gws: int) -> float:
    """Points per match implied by xG, xA, clean-sheet odds and bonus."""
    pos = row["position"]
    mins = row["minutes"]
    if mins <= 0:
        return 0.0
    per90 = 90.0 / mins
    xg90, xa90 = (row["xg"] or row["goals"]) * per90, (row["xa"] or row["assists"]) * per90
    xgc90 = row["xgc"] * per90 if row["xgc"] else 1.3
    cs_prob = math.exp(-xgc90)                           # Poisson P(0 goals conceded)
    bonus90 = row["bonus"] * per90
    per90_pts = (xg90 * GOAL_PTS.get(pos, 5) + xa90 * ASSIST_PTS
                 + cs_prob * CS_PTS.get(pos, 0) + bonus90 + 2)   # +2 appearance
    # How much of a match does he actually play?
    gws = max(finished_gws, 1)
    mins_share = min(1.0, mins / (gws * 90.0))
    starts_share = min(1.0, row["starts"] / gws) if row["starts"] else mins_share
    play_share = max(mins_share, starts_share * 0.9)
    return per90_pts * play_share


def fixture_multiplier(fx: dict) -> float:
    return FDR_MULT.get(int(fx.get("difficulty", 3)), 1.0) + (HOME_BONUS if fx.get("home") else 0.0)


def score_players(df: pd.DataFrame, finished_gws: int = 0, next_gw: int | None = None) -> pd.DataFrame:
    """Return a copy of df with expected-points columns added.

    Added columns: availability, base_xp, xp_next, xp_horizon, value,
    fdr_avg, n_fixtures, score (== xp_next, kept for backward compatibility).
    """
    df = df.copy()
    for col, default in _DEFAULTS.items():
        if col not in df.columns:
            df[col] = [default] * len(df)
    if "fixtures" not in df.columns:
        df["fixtures"] = [None] * len(df)

    num_cols = ["minutes", "starts", "goals", "assists", "xg", "xa", "xgc", "bonus",
                "form", "points_per_game", "ep_next", "now_cost"]
    df[num_cols] = df[num_cols].fillna(0).astype(float)

    df["availability"] = [availability(s, c) for s, c in zip(df["status"], df["chance_of_playing"])]
    underlying = df.apply(_underlying_per_match, axis=1, finished_gws=finished_gws)

    # Shrink the noisy underlying model toward PPG when the sample is small
    trust = (df["minutes"] / MIN_SAMPLE_MINUTES).clip(upper=1.0)
    underlying = trust * underlying + (1 - trust) * df["points_per_game"]

    # ep_next already bakes in availability; undo that so we don't double-count
    ep = df["ep_next"] / df["availability"].where(df["availability"] > 0, 1.0)

    base = (WEIGHTS["underlying"] * underlying + WEIGHTS["form"] * df["form"]
            + WEIGHTS["ppg"] * df["points_per_game"] + WEIGHTS["ep_next"] * ep)
    df["base_xp"] = base.round(3)

    xp_next, xp_h, fdr_avg, n_fx = [], [], [], []
    for b, avail, fixtures in zip(base, df["availability"], df["fixtures"]):
        fixtures = fixtures if isinstance(fixtures, list) else None
        if fixtures is None:          # no fixture data: assume one average game per GW
            xp_next.append(b * avail); xp_h.append(b * avail); fdr_avg.append(3.0); n_fx.append(1)
            continue
        gw0 = next_gw if next_gw is not None else (fixtures[0]["gw"] if fixtures else None)
        nxt = sum(b * fixture_multiplier(f) for f in fixtures if f["gw"] == gw0) * avail
        # Availability recovers over the horizon: later GWs use at least 0.75 for flagged players
        later_avail = max(avail, 0.75) if avail > 0 else 0.5
        hor = sum(b * fixture_multiplier(f) * (avail if f["gw"] == gw0 else later_avail)
                  for f in fixtures)
        xp_next.append(nxt); xp_h.append(hor)
        fdr_avg.append(sum(f["difficulty"] for f in fixtures) / len(fixtures) if fixtures else 5.0)
        n_fx.append(len(fixtures))

    df["xp_next"]    = pd.Series(xp_next, index=df.index).round(2)
    df["xp_horizon"] = pd.Series(xp_h, index=df.index).round(2)
    df["fdr_avg"]    = pd.Series(fdr_avg, index=df.index).round(2)
    df["n_fixtures"] = n_fx
    df["value"]      = (df["xp_horizon"] / df["now_cost"].where(df["now_cost"] > 0, 1.0)).round(3)
    df["score"]      = df["xp_next"]
    return df
