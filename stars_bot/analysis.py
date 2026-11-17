"""Cached FPL analysis for the bot (re-uses the repo's Python analyzer)."""
from __future__ import annotations

import threading
import time

import pandas as pd

from analysis.insights import analyze_my_team, market_insights
from models.captain import pick_captain
from models.expected_points import score_players
from scrapers.fpl import fetch_fpl_data, fetch_manager_team


class Analyzer:
    def __init__(self, horizon: int = 5, ttl: int = 3600,
                 fetch=fetch_fpl_data, fetch_team=fetch_manager_team):
        self.horizon, self.ttl = horizon, ttl
        self._fetch, self._fetch_team = fetch, fetch_team
        self._cache: dict | None = None
        self._at = 0.0
        self._lock = threading.Lock()

    def data(self) -> dict:
        """{'gameweek', 'scored', 'captain', 'insights'}, refreshed at most once per ttl."""
        with self._lock:
            if self._cache is None or time.time() - self._at > self.ttl:
                fpl = self._fetch(horizon=self.horizon)
                gw = fpl["gameweek"]
                scored = score_players(pd.DataFrame(fpl["players"]),
                                       finished_gws=gw.get("finished_gws", 0), next_gw=gw.get("next_gw"))
                self._cache = {"gameweek": gw, "scored": scored,
                               "captain": pick_captain(scored), "insights": market_insights(scored)}
                self._at = time.time()
            return self._cache

    def team(self, team_id: int) -> dict:
        d = self.data()
        return analyze_my_team(d["scored"], self._fetch_team(team_id))
