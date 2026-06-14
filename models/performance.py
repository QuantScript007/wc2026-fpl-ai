"""RandomForest regressor for FPL player performance projection."""
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

FEATURES = ["goals", "assists", "minutes"]


class PerformanceModel:
    """Trains on historical FPL data to project future fantasy points."""

    def __init__(self) -> None:
        self.model = RandomForestRegressor(n_estimators=100, random_state=42)

    def train(self, df: pd.DataFrame) -> None:
        """Fit the model. df must contain FEATURES columns + 'fantasy_points'."""
        self.model.fit(df[FEATURES], df["fantasy_points"])

    def predict(self, df: pd.DataFrame) -> list:
        """Return projected fantasy-point scores for each row in df."""
        return self.model.predict(df[FEATURES]).tolist()
