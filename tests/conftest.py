"""Shared pytest fixtures -- all data is synthetic, no network needed."""
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from factory import make_bootstrap, make_fixtures, valid_picks
from models.expected_points import score_players


@pytest.fixture
def sample_players() -> list:
    return [
        {"id": 1, "name": "Salah", "full_name": "Mohamed Salah", "team": "Liverpool", "team_short": "LIV",
         "team_id": 14, "position": "MID", "goals": 20, "assists": 10, "minutes": 2700, "starts": 30,
         "total_points": 230, "now_cost": 13.0, "selected_by": 45.2, "form": 9.5, "points_per_game": 7.7,
         "ep_next": 8.5, "xg": 18.0, "xa": 9.0, "xgc": 30.0, "bonus": 25, "status": "a",
         "chance_of_playing": None, "news": "",
         "fixtures": [{"gw": 38, "opponent": "MUN", "home": True, "difficulty": 3}],
         "next_fixture": "MUN (H)"},
        {"id": 2, "name": "Haaland", "full_name": "Erling Haaland", "team": "Man City", "team_short": "MCI",
         "team_id": 11, "position": "FWD", "goals": 35, "assists": 5, "minutes": 2500, "starts": 28,
         "total_points": 278, "now_cost": 15.0, "selected_by": 55.1, "form": 8.0, "points_per_game": 8.9,
         "ep_next": 9.0, "xg": 30.0, "xa": 4.0, "xgc": 25.0, "bonus": 30, "status": "a",
         "chance_of_playing": None, "news": "",
         "fixtures": [{"gw": 38, "opponent": "SHU", "home": True, "difficulty": 2}],
         "next_fixture": "SHU (H)"},
        {"id": 3, "name": "Trent", "full_name": "Trent Alexander-Arnold", "team": "Liverpool", "team_short": "LIV",
         "team_id": 14, "position": "DEF", "goals": 3, "assists": 12, "minutes": 2800, "starts": 31,
         "total_points": 162, "now_cost": 7.5, "selected_by": 22.3, "form": 6.0, "points_per_game": 5.2,
         "ep_next": 0.0, "xg": 2.5, "xa": 9.0, "xgc": 30.0, "bonus": 12, "status": "i",
         "chance_of_playing": 0, "news": "Hamstring",
         "fixtures": [{"gw": 38, "opponent": "MUN", "home": True, "difficulty": 3}],
         "next_fixture": "MUN (H)"},
    ]


@pytest.fixture
def sample_df(sample_players) -> pd.DataFrame:
    return pd.DataFrame(sample_players)


@pytest.fixture
def bootstrap() -> dict:
    return make_bootstrap()


@pytest.fixture
def fixtures() -> list:
    return make_fixtures()


@pytest.fixture
def picks() -> list:
    return valid_picks()


def fake_api(bootstrap, fixtures, fixtures_ok=True, picks=None):
    """side_effect for requests.Session.get that serves the fake FPL API."""
    def get(self, url, **kw):
        m = MagicMock()
        m.raise_for_status = MagicMock()
        if "bootstrap-static" in url:
            m.json.return_value = bootstrap
        elif "fixtures" in url:
            if not fixtures_ok:
                m.raise_for_status.side_effect = __import__("requests").HTTPError("500")
            m.json.return_value = fixtures
        elif url.endswith("/picks/"):
            m.json.return_value = {"picks": [{"element": e} for e in (picks or [])],
                                   "entry_history": {"bank": 15, "value": 1003}}
        else:
            m.json.return_value = {"name": "Test FC", "player_first_name": "Ana",
                                   "player_last_name": "Lee", "current_event": 5,
                                   "summary_overall_rank": 12345, "summary_overall_points": 321}
        return m
    return get


@pytest.fixture
def mock_api(bootstrap, fixtures, picks):
    with patch("requests.Session.get", fake_api(bootstrap, fixtures, picks=picks)):
        yield


@pytest.fixture
def fpl_data(mock_api) -> dict:
    from scrapers.fpl import fetch_fpl_data
    return fetch_fpl_data(horizon=5)


@pytest.fixture
def scored(fpl_data) -> pd.DataFrame:
    gw = fpl_data["gameweek"]
    return score_players(pd.DataFrame(fpl_data["players"]), gw["finished_gws"], gw["next_gw"])
