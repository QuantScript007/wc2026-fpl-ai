"""Unit tests for the squad optimizer, analysis and report pipeline."""
from unittest.mock import patch

import pandas as pd
import pytest

from analysis.insights import analyze_my_team, market_insights, suggest_transfers
from optimizer.squad import (SQUAD_SLOTS, XI_LIMITS, OptimizationError, best_xi,
                             build_optimal_squad, lineup_to_records)


def _check_xi(starters):
    counts = starters["position"].value_counts()
    assert len(starters) == 11
    for pos, (lo, hi) in XI_LIMITS.items():
        assert lo <= counts.get(pos, 0) <= hi


class TestOptimalSquad:
    @pytest.fixture
    def result(self, scored):
        return build_optimal_squad(scored, budget=100.0)

    def test_squad_shape(self, result):
        squad = pd.concat([result["starters"], result["bench"]])
        assert len(squad) == 15 and len(result["bench"]) == 4
        assert squad["position"].value_counts().to_dict() == SQUAD_SLOTS

    def test_budget(self, result):
        assert result["total_cost"] <= 100.0 and result["bank"] >= 0

    def test_max_three_per_club(self, result):
        squad = pd.concat([result["starters"], result["bench"]])
        assert squad["team_id"].value_counts().max() <= 3

    def test_valid_formation(self, result):
        _check_xi(result["starters"])
        d, m, f = map(int, result["formation"].split("-"))
        assert d + m + f == 10

    def test_excludes_injured(self, result):
        squad = pd.concat([result["starters"], result["bench"]])
        assert (squad["availability"] >= 0.5).all()

    def test_captain_is_best_starter(self, result):
        assert result["captain"] == result["starters"].sort_values("xp_next").iloc[-1]["name"]

    def test_backup_gk_last_on_bench(self, result):
        assert result["bench"].iloc[-1]["position"] == "GKP"

    def test_budget_binds(self, scored):
        cheap = build_optimal_squad(scored, budget=80.0)
        rich = build_optimal_squad(scored, budget=100.0)
        assert cheap["total_cost"] <= 80.0
        assert cheap["xp_horizon"] <= rich["xp_horizon"] + 1e-6

    def test_below_unconstrained_bound(self, scored, result):
        greedy = scored.sort_values("xp_horizon", ascending=False).head(11)["xp_horizon"].sum()
        assert result["xp_horizon"] <= greedy + 1e-6   # sanity: can't beat unconstrained top 11

    def test_infeasible_raises(self, scored):
        with pytest.raises(OptimizationError):
            build_optimal_squad(scored, budget=20.0)

    def test_records_are_json_friendly(self, result):
        rec = lineup_to_records(result, ["name", "position"])
        assert set(rec["starters"][0]) == {"name", "position"}


class TestBestXi:
    def test_from_squad(self, scored, picks):
        res = best_xi(scored[scored["id"].isin(picks)])
        _check_xi(res["starters"])
        assert len(res["bench"]) == 4

    def test_prefers_higher_xp(self, scored, picks):
        squad = scored[scored["id"].isin(picks)]
        res = best_xi(squad)
        benched_outfield = res["bench"][res["bench"]["position"] != "GKP"]
        # every benched outfielder must be required-out by formation or be worse than some starter
        assert benched_outfield["xp_next"].max() <= res["starters"]["xp_next"].max()

    def test_too_few_players(self, scored):
        with pytest.raises(OptimizationError):
            best_xi(scored.head(5))


class TestInsights:
    def test_transfers_respect_rules(self, scored, picks):
        moves = suggest_transfers(scored, picks, bank=1.5)
        assert moves and moves == sorted(moves, key=lambda m: -m["gain"])
        by_id = scored.set_index("id")
        for m in moves:
            assert m["out"]["id"] in picks and m["in"]["id"] not in picks
            assert m["in"]["position"] == m["out"]["position"]
            assert by_id.loc[m["in"]["id"], "now_cost"] <= by_id.loc[m["out"]["id"], "now_cost"] + 1.5

    def test_zero_bank_limits_price(self, scored, picks):
        by_id = scored.set_index("id")
        for m in suggest_transfers(scored, picks, bank=0.0):
            assert by_id.loc[m["in"]["id"], "now_cost"] <= by_id.loc[m["out"]["id"], "now_cost"]

    def test_my_team(self, scored, picks):
        manager = {"entry_id": 1, "team_name": "T", "manager": "M", "gameweek": 5, "bank": 1.0,
                   "team_value": 100.0, "overall_rank": 1, "overall_points": 1, "picks": picks}
        res = analyze_my_team(scored, manager)
        assert len(res["lineup"]["starters"]) == 11 and res["advice"]
        assert "picks" not in res

    def test_market(self, scored):
        ins = market_insights(scored)
        assert all(p["selected_by"] < 10 for p in ins["differentials"])
        assert set(ins["value_picks"]) == {"GKP", "DEF", "MID", "FWD"}
        fdr = [t["fdr_avg"] for t in ins["fixture_ticker"] if t["fdr_avg"] is not None]
        assert fdr == sorted(fdr) and len(ins["fixture_ticker"]) == 20


class TestPipeline:
    def test_build_report(self, fpl_data, picks):
        import main
        manager = {"entry_id": 1, "team_name": "T", "manager": "M", "gameweek": 5, "bank": 1.0,
                   "team_value": 100.0, "overall_rank": 1, "overall_points": 1, "picks": picks}
        rep = main.build_report(fpl_data, manager)
        assert rep["captain"]["captain"] and rep["optimal_squad"]["formation"]
        assert rep["my_team"]["lineup"]["captain"]
        assert len(rep["players"]) == len(fpl_data["players"])
        msg = main.telegram_summary(rep)
        assert "Captain" in msg and "T" in msg

    def test_run_writes_file(self, mock_api, tmp_path, monkeypatch):
        import json, main
        monkeypatch.setattr(main, "DATA_FILE", tmp_path / "out.json")
        with patch("main.send") as send:
            rep = main.run(team_id=42)
        assert json.loads((tmp_path / "out.json").read_text())["captain"]["captain"] == rep["captain"]["captain"]
        send.assert_called_once()

    def test_run_survives_api_outage(self, tmp_path, monkeypatch):
        import main
        monkeypatch.setattr(main, "DATA_FILE", tmp_path / "out.json")
        with patch("main.fetch_fpl_data", side_effect=ConnectionError("down")):
            assert main.run() is None
        assert not (tmp_path / "out.json").exists()


class TestApp:
    @pytest.fixture
    def client(self, tmp_path, monkeypatch):
        import app, main
        monkeypatch.setattr(app, "DATA_FILE", tmp_path / "none.json")
        return app.app.test_client()

    def test_index(self, client):
        r = client.get("/")
        assert r.status_code == 200 and b"FPL AI Analyzer" in r.data

    def test_data_empty(self, client):
        assert client.get("/api/data").get_json()["players"] == []

    def test_refresh_rejects_bad_team(self, client):
        assert client.post("/api/refresh", json={"team_id": "abc"}).status_code == 400
