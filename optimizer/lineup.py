"""FPL lineup optimizer -- build the best XI and 4 subs by score."""
import pandas as pd


def build_best_xi(df: pd.DataFrame) -> tuple:
    """Return (starting_xi, subs) sorted by composite score, descending."""
    if "score" not in df.columns:
        df = df.copy()
        df["score"] = df["goals"] * 4 + df["assists"] * 3 + df["minutes"] * 0.02
    df = df.sort_values("score", ascending=False).reset_index(drop=True)
    return df.head(11), df.iloc[11:15]
