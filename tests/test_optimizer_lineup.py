"""Unit tests for optimizer.lineup."""
import pandas as pd
import pytest
from optimizer.lineup import build_best_xi


class TestBuildBestXi:
    def test_returns_two_dfs(self, squad_20):
        xi, subs = build_best_xi(squad_20)
        assert isinstance(xi, pd.DataFrame) and isinstance(subs, pd.DataFrame)

    def test_xi_size(self, squad_20): assert len(build_best_xi(squad_20)[0]) == 11
    def test_subs_size(self, squad_20): assert len(build_best_xi(squad_20)[1]) == 4

    def test_xi_is_top_11(self, squad_20):
        xi, _ = build_best_xi(squad_20)
        expected = set(squad_20.sort_values("score",ascending=False).head(11)["name"])
        assert set(xi["name"]) == expected

    def test_no_overlap(self, squad_20):
        xi, subs = build_best_xi(squad_20)
        assert set(xi["name"]).isdisjoint(set(subs["name"]))

    def test_derives_score(self, squad_20_no_score):
        xi, subs = build_best_xi(squad_20_no_score)
        assert len(xi)==11 and len(subs)==4

    def test_no_mutation(self, squad_20_no_score):
        cols = set(squad_20_no_score.columns); build_best_xi(squad_20_no_score)
        assert set(squad_20_no_score.columns) == cols

    def test_small_squad(self):
        df = pd.DataFrame([{"name":f"P{i}","score":float(12-i),"goals":1,"assists":0,"minutes":90}
                           for i in range(12)])
        xi, subs = build_best_xi(df)
        assert len(xi)==11 and len(subs)==1

    def test_exact_eleven(self):
        df = pd.DataFrame([{"name":f"P{i}","score":float(11-i),"goals":1,"assists":0,"minutes":90}
                           for i in range(11)])
        xi, subs = build_best_xi(df)
        assert len(xi)==11 and len(subs)==0
