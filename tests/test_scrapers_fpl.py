"""Unit tests for scrapers.fpl -- all HTTP calls are mocked."""
import pytest, requests
from unittest.mock import MagicMock, patch
from scrapers.fpl import fetch_player_data, _fetch_next_fixtures

REQUIRED = {"id","name","full_name","team","team_short","team_id","position","goals","assists",
            "minutes","total_points","now_cost","selected_by","form","next_fixture","status"}


def _make_mock(bootstrap, fixtures=None, fixtures_ok=True):
    def side_effect(url, **kw):
        m = MagicMock(); m.raise_for_status = MagicMock()
        if "bootstrap-static" in url:
            m.json.return_value = bootstrap
        else:
            m.ok = fixtures_ok
            if fixtures_ok and fixtures: m.json.return_value = fixtures
        return m
    return side_effect


class TestFetchPlayerData:
    @patch("scrapers.fpl.requests.get")
    def test_returns_list_of_dicts(self, mg, fake_fpl_bootstrap, fake_fpl_fixtures):
        mg.side_effect = _make_mock(fake_fpl_bootstrap, fake_fpl_fixtures)
        assert all(isinstance(p,dict) for p in fetch_player_data())

    @patch("scrapers.fpl.requests.get")
    def test_correct_player_count(self, mg, fake_fpl_bootstrap, fake_fpl_fixtures):
        mg.side_effect = _make_mock(fake_fpl_bootstrap, fake_fpl_fixtures)
        assert len(fetch_player_data()) == 2

    @patch("scrapers.fpl.requests.get")
    def test_all_required_fields(self, mg, fake_fpl_bootstrap, fake_fpl_fixtures):
        mg.side_effect = _make_mock(fake_fpl_bootstrap, fake_fpl_fixtures)
        for p in fetch_player_data():
            assert not REQUIRED - p.keys()

    @patch("scrapers.fpl.requests.get")
    def test_position_mapping(self, mg, fake_fpl_bootstrap, fake_fpl_fixtures):
        mg.side_effect = _make_mock(fake_fpl_bootstrap, fake_fpl_fixtures)
        by = {p["name"]:p for p in fetch_player_data()}
        assert by["Salah"]["position"] == "MID"
        assert by["Haaland"]["position"] == "FWD"

    @patch("scrapers.fpl.requests.get")
    def test_cost_divided_by_ten(self, mg, fake_fpl_bootstrap, fake_fpl_fixtures):
        mg.side_effect = _make_mock(fake_fpl_bootstrap, fake_fpl_fixtures)
        by = {p["name"]:p for p in fetch_player_data()}
        assert by["Salah"]["now_cost"] == 13.0

    @patch("scrapers.fpl.requests.get")
    def test_main_api_failure_raises(self, mg):
        mg.return_value.raise_for_status.side_effect = requests.HTTPError("503")
        with pytest.raises(requests.HTTPError):
            fetch_player_data()

    @patch("scrapers.fpl.requests.get")
    def test_fixture_failure_returns_tbc(self, mg, fake_fpl_bootstrap):
        mg.side_effect = _make_mock(fake_fpl_bootstrap, fixtures_ok=False)
        result = fetch_player_data()
        assert all(p["next_fixture"]=="TBC" for p in result)
