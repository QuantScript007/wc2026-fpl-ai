"""Shared pytest fixtures."""
import pandas as pd
import pytest


@pytest.fixture
def sample_players() -> list:
    return [
        {"id":1,"name":"Salah","full_name":"Mohamed Salah","team":"Liverpool","team_short":"LIV","team_id":14,
         "position":"MID","goals":20,"assists":10,"minutes":2700,"total_points":230,"now_cost":13.0,
         "selected_by":45.2,"form":9.5,"next_fixture":"GW38 vs MUN (H)","status":"a"},
        {"id":2,"name":"Haaland","full_name":"Erling Haaland","team":"Man City","team_short":"MCI","team_id":11,
         "position":"FWD","goals":35,"assists":5,"minutes":2500,"total_points":278,"now_cost":15.0,
         "selected_by":55.1,"form":8.0,"next_fixture":"GW38 vs CHE (A)","status":"a"},
        {"id":3,"name":"Trent","full_name":"Trent Alexander-Arnold","team":"Liverpool","team_short":"LIV","team_id":14,
         "position":"DEF","goals":3,"assists":12,"minutes":2800,"total_points":162,"now_cost":7.5,
         "selected_by":22.3,"form":6.0,"next_fixture":"GW38 vs MUN (H)","status":"a"},
    ]


@pytest.fixture
def sample_df(sample_players) -> pd.DataFrame:
    return pd.DataFrame(sample_players)


@pytest.fixture
def squad_20() -> pd.DataFrame:
    return pd.DataFrame([
        {"name": f"Player{i}", "score": float(20-i), "goals": i%5, "assists": i%3, "minutes": 90*(i+1)}
        for i in range(20)
    ])


@pytest.fixture
def squad_20_no_score() -> pd.DataFrame:
    return pd.DataFrame([
        {"name": f"Player{i}", "goals": i%5, "assists": i%3, "minutes": 90*(i+1)}
        for i in range(20)
    ])


@pytest.fixture
def fake_fpl_bootstrap() -> dict:
    return {
        "teams": [{"id":14,"name":"Liverpool","short_name":"LIV"},{"id":11,"name":"Man City","short_name":"MCI"}],
        "elements": [
            {"id":1,"web_name":"Salah","first_name":"Mohamed","second_name":"Salah","team":14,"element_type":3,
             "goals_scored":20,"assists":10,"minutes":2700,"total_points":230,"now_cost":130,
             "selected_by_percent":"45.2","form":"9.5","status":"a"},
            {"id":2,"web_name":"Haaland","first_name":"Erling","second_name":"Haaland","team":11,"element_type":4,
             "goals_scored":35,"assists":5,"minutes":2500,"total_points":278,"now_cost":150,
             "selected_by_percent":"55.1","form":"8.0","status":"a"},
        ],
    }


@pytest.fixture
def fake_fpl_fixtures() -> list:
    return [{"team_h":14,"team_a":11,"event":38},{"team_h":11,"team_a":14,"event":37}]
