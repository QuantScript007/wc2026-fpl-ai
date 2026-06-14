"""Captain-pick scoring model for FPL."""
import pandas as pd


def pick_captain(df: pd.DataFrame) -> dict:
    """Score every player and return the highest-scoring captain pick."""
    df = df.copy()
    df["score"] = (
        df["goals"] * 4 + df["assists"] * 3 + df["minutes"] * 0.02
        + df.get("form", pd.Series(0.0, index=df.index)) * 5
        + df.get("total_points", pd.Series(0.0, index=df.index)) * 0.1
    )
    top = df.sort_values("score", ascending=False).iloc[0]
    return {"captain": top["name"], "score": float(top["score"])}
