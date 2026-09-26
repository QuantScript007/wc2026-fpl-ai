"""Unit tests for scrapers.fpl -- all HTTP calls are mocked."""
from unittest.mock import patch

import pytest
import requests

from conftest import fake_api
from scrapers.fpl import _gameweek_info, _team_fixtures, fetch_fpl_data, fetch_manager_team, fetch_player_data

REQUIRED = {"id", "name", "full_name", "team", "team_short", "team_id", "position", "goals", "assists",
            "minutes", "total_points", "now_cost", "selected_by", "form", "next_fixture", "status",
            "xg", "xa", "ep_next", "points_per_game", "chance_of_playing", "fixtures", "news"}


class TestFetchFplData:
    def test_player_count(self, fpl_data, bootstrap):
        assert len(fpl_data["players"]) == len(bootstrap["elements"])

    def test_required_fields(self, fpl_data):
        for p in fpl_data["players"]:
            assert not REQUIRED - p.keys()

    def test_position_and_cost(self, fpl_data, bootstrap):
        raw = bootstrap["elements"][0]
        p = fpl_data["players"][0]
        assert p["position"] == {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}[raw["element_type"]]
        assert p["now_cost"] == round(raw["now_cost"] / 10, 1)

    def test_numeric_strings_coerced(self, fpl_data):
        p = fpl_data["players"][0]
        assert isinstance(p["form"], float) and isinstance(p["xg"], float)

    def test_gameweek_info(self, fpl_data):
        gw = fpl_data["gameweek"]
        assert gw["next_gw"] == 6 and gw["finished_gws"] == 5

    def test_double_and_blank_gameweeks(self, fpl_data):
        by_team = {p["team_id"]: p for p in fpl_data["players"]}
        assert sum(f["gw"] == 6 for f in by_team[1]["fixtures"]) == 2       # double
        assert by_team[20]["next_fixture"] == "BLANK"                        # blank

    def test_fixtures_within_horizon(self, fpl_data):
        for p in fpl_data["players"]:
            assert all(6 <= f["gw"] <= 10 for f in p["fixtures"])

    def test_main_api_failure_raises(self):
        with patch("requests.Session.get") as mg:
            mg.return_value.raise_for_status.side_effect = requests.HTTPError("503")
            with pytest.raises(requests.HTTPError):
                fetch_fpl_data()

    def test_fixture_failure_is_tolerated(self, bootstrap, fixtures):
        with patch("requests.Session.get", fake_api(bootstrap, fixtures, fixtures_ok=False)):
            players = fetch_player_data()
        assert players and all(p["fixtures"] == [] for p in players)


class TestHelpers:
    def test_gameweek_falls_back_to_first_unfinished(self):
        events = [{"id": 1, "finished": True}, {"id": 2, "finished": False}]
        assert _gameweek_info(events)["next_gw"] == 2

    def test_season_over(self):
        assert _gameweek_info([{"id": 38, "finished": True}])["next_gw"] is None

    def test_team_fixtures_difficulty_per_side(self):
        teams = {1: {"short": "AAA"}, 2: {"short": "BBB"}}
        fx = [{"event": 3, "team_h": 1, "team_a": 2, "team_h_difficulty": 2, "team_a_difficulty": 5}]
        out = _team_fixtures(fx, teams, 3, 1)
        assert out[1][0] == {"gw": 3, "opponent": "BBB", "home": True, "difficulty": 2}
        assert out[2][0]["difficulty"] == 5 and out[2][0]["home"] is False


class TestManagerTeam:
    def test_fetch_manager(self, mock_api, picks):
        m = fetch_manager_team(42)
        assert m["picks"] == picks and m["bank"] == 1.5 and m["team_value"] == 100.3
        assert m["team_name"] == "Test FC" and m["gameweek"] == 5
