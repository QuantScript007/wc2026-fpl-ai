"""Unit tests for models.captain."""
import pandas as pd
from models.captain import pick_captain


class TestPickCaptain:
    def test_returns_dict(self, sample_df): assert isinstance(pick_captain(sample_df), dict)
    def test_has_keys(self, sample_df): assert {"captain","score"} <= pick_captain(sample_df).keys()
    def test_score_is_float(self, sample_df): assert isinstance(pick_captain(sample_df)["score"], float)

    def test_selects_correct_captain(self, sample_df):
        # Haaland: 35*4+5*3+2500*0.02+8*5+278*0.1=272.8 > Salah 234.5
        assert pick_captain(sample_df)["captain"] == "Haaland"

    def test_goals_weighted_4x(self):
        df = pd.DataFrame([{"name":"A","goals":10,"assists":0,"minutes":0},
                           {"name":"B","goals":0,"assists":0,"minutes":0}])
        assert pick_captain(df)["captain"] == "A"

    def test_form_overrides_goals(self):
        df = pd.DataFrame([{"name":"A","goals":0,"assists":0,"minutes":0,"form":10.0},
                           {"name":"B","goals":1,"assists":0,"minutes":0,"form":0.0}])
        assert pick_captain(df)["captain"] == "A"

    def test_optional_columns(self):
        df = pd.DataFrame([{"name":"A","goals":5,"assists":3,"minutes":900},
                           {"name":"B","goals":1,"assists":0,"minutes":100}])
        assert pick_captain(df)["captain"] == "A"

    def test_no_mutation(self, sample_df):
        cols = set(sample_df.columns); pick_captain(sample_df)
        assert set(sample_df.columns) == cols
