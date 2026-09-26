"""Unit tests for the expected-points model and captain picker."""
import pandas as pd
import pytest

from models.captain import pick_captain
from models.expected_points import availability, fixture_multiplier, score_players


class TestAvailability:
    @pytest.mark.parametrize("status,chance,expected", [
        ("a", None, 1.0), ("d", None, 0.5), ("i", None, 0.0), ("s", None, 0.0),
        ("d", 75, 0.75), ("i", 0, 0.0), ("a", 100, 1.0)])
    def test_values(self, status, chance, expected):
        assert availability(status, chance) == expected

    def test_nan_chance_uses_status(self):
        assert availability("a", float("nan")) == 1.0


class TestScorePlayers:
    def test_adds_columns(self, sample_df):
        out = score_players(sample_df)
        for c in ["availability", "xp_next", "xp_horizon", "value", "fdr_avg", "score", "base_xp"]:
            assert c in out.columns

    def test_no_mutation(self, sample_df):
        cols = set(sample_df.columns)
        score_players(sample_df)
        assert set(sample_df.columns) == cols

    def test_injured_player_scores_zero_next(self, sample_df):
        out = score_players(sample_df).set_index("name")
        assert out.loc["Trent", "xp_next"] == 0

    def test_easier_fixture_scores_higher(self, sample_df):
        easy, hard = sample_df.iloc[[1]].copy(), sample_df.iloc[[1]].copy()
        easy["fixtures"] = [[{"gw": 1, "opponent": "X", "home": True, "difficulty": 1}]]
        hard["fixtures"] = [[{"gw": 1, "opponent": "X", "home": True, "difficulty": 5}]]
        assert score_players(easy)["xp_next"].iloc[0] > score_players(hard)["xp_next"].iloc[0]

    def test_double_gameweek_roughly_doubles(self, sample_df):
        single, double = sample_df.iloc[[1]].copy(), sample_df.iloc[[1]].copy()
        f = {"gw": 1, "opponent": "X", "home": True, "difficulty": 3}
        single["fixtures"] = [[f]]
        double["fixtures"] = [[f, dict(f)]]
        assert score_players(double)["xp_next"].iloc[0] == pytest.approx(
            2 * score_players(single)["xp_next"].iloc[0], rel=0.01)

    def test_blank_gameweek_is_zero(self, sample_df):
        df = sample_df.iloc[[1]].copy()
        df["fixtures"] = [[{"gw": 2, "opponent": "X", "home": True, "difficulty": 3}]]
        assert score_players(df, next_gw=1)["xp_next"].iloc[0] == 0

    def test_minimal_columns(self):
        df = pd.DataFrame([{"name": "A", "goals": 5, "assists": 3, "minutes": 900},
                           {"name": "B", "goals": 0, "assists": 0, "minutes": 90}])
        out = score_players(df, finished_gws=10)
        assert out.set_index("name").loc["A", "xp_next"] > out.set_index("name").loc["B", "xp_next"]

    def test_home_bonus(self):
        assert fixture_multiplier({"difficulty": 3, "home": True}) > fixture_multiplier({"difficulty": 3, "home": False})


class TestPickCaptain:
    def test_keys(self, sample_df):
        c = pick_captain(sample_df)
        assert {"captain", "vice_captain", "score", "options"} <= c.keys()
        assert isinstance(c["score"], float)

    def test_best_player_captained(self, sample_df):
        assert pick_captain(sample_df)["captain"] == "Haaland"
        assert pick_captain(sample_df)["vice_captain"] == "Salah"

    def test_injured_never_captain(self, sample_df):
        df = sample_df.copy()
        df.loc[df["name"] == "Trent", ["status", "chance_of_playing", "form", "ep_next"]] = ["a", 0, 99.0, 99.0]
        assert pick_captain(df)["captain"] != "Trent"

    def test_empty(self):
        assert pick_captain(pd.DataFrame())["captain"] is None

    def test_no_mutation(self, sample_df):
        cols = set(sample_df.columns)
        pick_captain(sample_df)
        assert set(sample_df.columns) == cols

    def test_on_real_shaped_data(self, scored):
        cap = pick_captain(scored)
        top = scored[scored["availability"] >= 0.75]["xp_next"].max()
        assert cap["score"] == pytest.approx(top)
