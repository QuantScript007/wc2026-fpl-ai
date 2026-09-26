"""Captain and vice-captain picks based on next-gameweek expected points."""
from __future__ import annotations

import pandas as pd

from models.expected_points import score_players


def pick_captain(df: pd.DataFrame, top_n: int = 5) -> dict:
    """Return the best captain, vice-captain and a shortlist of options.

    df may be raw player data or already scored by score_players(); the
    input frame is never mutated.
    """
    if df.empty:
        return {"captain": None, "vice_captain": None, "score": 0.0, "options": []}
    scored = df if "xp_next" in df.columns else score_players(df)
    pool = scored[scored["availability"] >= 0.75] if "availability" in scored else scored
    if pool.empty:
        pool = scored
    ranked = pool.sort_values(["xp_next", "form"], ascending=False)
    top = ranked.iloc[0]
    vice = ranked.iloc[1] if len(ranked) > 1 else None
    cols = [c for c in ["id", "name", "team_short", "position", "xp_next", "next_fixture",
                        "selected_by", "form"] if c in ranked.columns]
    return {
        "captain":      top["name"],
        "vice_captain": None if vice is None else vice["name"],
        "score":        float(top["xp_next"]),
        "options":      ranked.head(top_n)[cols].to_dict(orient="records"),
    }
