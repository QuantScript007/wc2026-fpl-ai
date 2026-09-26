"""FPL squad optimizer -- exact integer programming with FPL's real rules.

Squad:   15 players = 2 GKP, 5 DEF, 5 MID, 3 FWD, max 3 per club, within budget.
Lineup:  11 starters = 1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD.
Captain: the starter with the highest next-GW expected points (points doubled).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import Bounds, LinearConstraint, milp

SQUAD_SLOTS  = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}
XI_LIMITS    = {"GKP": (1, 1), "DEF": (3, 5), "MID": (2, 5), "FWD": (1, 3)}
POS_ORDER    = {"GKP": 0, "DEF": 1, "MID": 2, "FWD": 3}
MAX_PER_TEAM = 3
BENCH_WEIGHT = 0.1   # bench players still matter a little (auto-subs)


class OptimizationError(RuntimeError):
    pass


def _solve(c: np.ndarray, constraints: list, n_vars: int) -> np.ndarray:
    res = milp(c=c, constraints=constraints, integrality=np.ones(n_vars),
               bounds=Bounds(0, 1), options={"time_limit": 30})
    if res.x is None:
        raise OptimizationError(f"No feasible squad found: {res.message}")
    return np.round(res.x).astype(int)


def _pick_lineup_vars(df: pd.DataFrame, metric: str) -> tuple:
    """Build the starter constraints (for a fixed or variable squad)."""
    n = len(df)
    pos = df["position"].to_numpy()
    rows, lo, hi = [], [], []
    rows.append(np.ones(n)); lo.append(11); hi.append(11)
    for p, (a, b) in XI_LIMITS.items():
        rows.append((pos == p).astype(float)); lo.append(a); hi.append(b)
    return np.array(rows), np.array(lo), np.array(hi)


def _captain(starters: pd.DataFrame) -> tuple:
    if starters.empty or "xp_next" not in starters:
        return None, None
    ranked = starters.sort_values("xp_next", ascending=False)
    cap = ranked.iloc[0]["name"]
    vice = ranked.iloc[1]["name"] if len(ranked) > 1 else None
    return cap, vice


def _package(squad: pd.DataFrame, starter_mask: np.ndarray, metric: str, budget: float | None) -> dict:
    squad = squad.copy()
    squad["starter"] = starter_mask.astype(bool)
    starters = squad[squad["starter"]].sort_values(
        ["position", metric], key=lambda s: s.map(POS_ORDER) if s.name == "position" else -s)
    bench = squad[~squad["starter"]]
    # FPL bench order: outfield by expected points, backup GK last
    bench = pd.concat([bench[bench["position"] != "GKP"].sort_values(metric, ascending=False),
                       bench[bench["position"] == "GKP"]])
    cap, vice = _captain(starters)
    counts = starters["position"].value_counts()
    formation = "-".join(str(int(counts.get(p, 0))) for p in ("DEF", "MID", "FWD"))
    cost = round(float(squad["now_cost"].sum()), 1)
    cap_bonus = float(starters.loc[starters["name"] == cap, "xp_next"].iloc[0]) if cap else 0.0
    return {
        "starters":        starters.drop(columns=["starter"]),
        "bench":           bench.drop(columns=["starter"]),
        "captain":         cap,
        "vice_captain":    vice,
        "formation":       formation,
        "total_cost":      cost,
        "bank":            None if budget is None else round(budget - cost, 1),
        "xp_next":         round(float(starters["xp_next"].sum()) + cap_bonus, 2) if "xp_next" in starters else None,
        "xp_horizon":      round(float(starters["xp_horizon"].sum()), 2) if "xp_horizon" in starters else None,
    }


def build_optimal_squad(df: pd.DataFrame, budget: float = 100.0, metric: str = "xp_horizon",
                        max_per_team: int = MAX_PER_TEAM, min_availability: float = 0.5,
                        bench_weight: float = BENCH_WEIGHT) -> dict:
    """Pick the best-possible 15 from scratch (wildcard / free hit planner)."""
    pool = df.copy()
    if "availability" in pool:
        pool = pool[pool["availability"] >= min_availability]
    pool = pool[pool["position"].isin(SQUAD_SLOTS)].reset_index(drop=True)
    n = len(pool)
    if n < 15:
        raise OptimizationError("Need at least 15 eligible players")

    val = pool[metric].to_numpy(dtype=float)
    cost = pool["now_cost"].to_numpy(dtype=float)
    pos = pool["position"].to_numpy()
    team = pool["team_id"].to_numpy() if "team_id" in pool else pool["team"].to_numpy()
    Z = np.zeros(n)

    # vars: x (in squad) [0..n), s (starter) [n..2n)
    c = -np.concatenate([bench_weight * val, (1 - bench_weight) * val])
    A, lo, hi = [], [], []

    def add(xrow, srow, a, b):
        A.append(np.concatenate([xrow, srow])); lo.append(a); hi.append(b)

    add(np.ones(n), Z, 15, 15)
    add(cost, Z, 0, budget)
    for p, k in SQUAD_SLOTS.items():
        add((pos == p).astype(float), Z, k, k)
    for t in np.unique(team):
        add((team == t).astype(float), Z, 0, max_per_team)
    xi_rows, xi_lo, xi_hi = _pick_lineup_vars(pool, metric)
    for r, a, b in zip(xi_rows, xi_lo, xi_hi):
        add(Z, r, a, b)
    link = np.hstack([-np.eye(n), np.eye(n)])           # s_i - x_i <= 0
    cons = [LinearConstraint(np.array(A), lo, hi), LinearConstraint(link, -np.inf, 0)]

    sol = _solve(c, cons, 2 * n)
    x, s = sol[:n].astype(bool), sol[n:]
    return _package(pool[x], s[x], metric, budget)


def best_xi(squad: pd.DataFrame, metric: str = "xp_next") -> dict:
    """Pick the best valid starting XI (and bench order) from a given squad."""
    squad = squad.reset_index(drop=True)
    if len(squad) < 11:
        raise OptimizationError("A lineup needs at least 11 players")
    val = squad[metric].to_numpy(dtype=float)
    rows, lo, hi = _pick_lineup_vars(squad, metric)
    s = _solve(-val, [LinearConstraint(rows, lo, hi)], len(squad))
    return _package(squad, s, metric, None)


def lineup_to_records(result: dict, cols: list | None = None) -> dict:
    """JSON-friendly version of a build_optimal_squad / best_xi result."""
    def recs(frame):
        frame = frame if cols is None else frame[[c for c in cols if c in frame.columns]]
        return frame.to_dict(orient="records")
    out = {k: v for k, v in result.items() if k not in ("starters", "bench")}
    out["starters"] = recs(result["starters"])
    out["bench"] = recs(result["bench"])
    return out
