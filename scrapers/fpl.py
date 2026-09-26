"""FPL API client -- players, gameweeks, fixtures (with difficulty) and manager teams."""
from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL     = "https://fantasy.premierleague.com/api"
FPL_API      = f"{BASE_URL}/bootstrap-static/"
FIXTURES_API = f"{BASE_URL}/fixtures/?future=1"
HEADERS      = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
POSITION_MAP = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}


def _get_session_with_retries(retries: int = 3, backoff_factor: float = 0.5) -> requests.Session:
    """Create a requests session with automatic retry logic."""
    session = requests.Session()
    retry = Retry(total=retries, backoff_factor=backoff_factor,
                  status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET"])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(HEADERS)
    return session


def _get_json(session: requests.Session, url: str, timeout: int = 15):
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _num(value, default: float = 0.0) -> float:
    """FPL returns many numbers as strings ("5.2"); coerce safely."""
    try:
        return float(value) if value is not None and value != "" else default
    except (TypeError, ValueError):
        return default


def _gameweek_info(events: list) -> dict:
    """Work out the next gameweek to plan for and how many are finished."""
    finished = [e["id"] for e in events if e.get("finished")]
    nxt = next((e for e in events if e.get("is_next")), None)
    if nxt is None:
        nxt = next((e for e in events if not e.get("finished")), None)
    current = next((e["id"] for e in events if e.get("is_current")), None)
    return {
        "next_gw":        nxt["id"] if nxt else None,
        "next_deadline":  nxt.get("deadline_time") if nxt else None,
        "current_gw":     current,
        "finished_gws":   len(finished),
        "total_gws":      len(events),
    }


def _team_fixtures(fixtures: list, teams: dict, start_gw: int | None, horizon: int) -> dict:
    """Return {team_id: [fixture, ...]} for GWs start_gw .. start_gw+horizon-1.

    Blank gameweeks simply have no entry; double gameweeks have two.
    """
    out: dict = {tid: [] for tid in teams}
    if start_gw is None:
        return out
    last_gw = start_gw + horizon - 1
    for fx in fixtures:
        gw = fx.get("event")
        if gw is None or not (start_gw <= gw <= last_gw):
            continue
        h, a = fx["team_h"], fx["team_a"]
        out.setdefault(h, []).append({
            "gw": gw, "opponent": teams.get(a, {}).get("short", "?"), "home": True,
            "difficulty": int(fx.get("team_h_difficulty") or 3)})
        out.setdefault(a, []).append({
            "gw": gw, "opponent": teams.get(h, {}).get("short", "?"), "home": False,
            "difficulty": int(fx.get("team_a_difficulty") or 3)})
    for lst in out.values():
        lst.sort(key=lambda f: f["gw"])
    return out


def _fixture_label(fixtures: list) -> str:
    if not fixtures:
        return "BLANK"
    return ", ".join(f"{f['opponent']} ({'H' if f['home'] else 'A'})" for f in fixtures)


def fetch_fpl_data(horizon: int = 5) -> dict:
    """Fetch everything the analyzer needs in one go.

    Returns {"players": [...], "teams": [...], "gameweek": {...}}.
    Raises requests.HTTPError / ConnectionError if the main FPL endpoint fails.
    """
    session = _get_session_with_retries()
    try:
        data = _get_json(session, FPL_API)
        teams = {t["id"]: {"id": t["id"], "name": t["name"], "short": t["short_name"]}
                 for t in data["teams"]}
        gw = _gameweek_info(data.get("events", []))
        try:
            fixtures = _get_json(session, FIXTURES_API, timeout=10)
        except Exception as e:  # fixtures are a nice-to-have
            print(f"[FPL] Fixture fetch failed: {e}")
            fixtures = []
        by_team = _team_fixtures(fixtures, teams, gw["next_gw"], horizon)

        players = []
        for p in data["elements"]:
            team = teams.get(p["team"], {"name": "?", "short": "?"})
            upcoming = by_team.get(p["team"], [])
            next_gw_fx = [f for f in upcoming if f["gw"] == gw["next_gw"]]
            cop = p.get("chance_of_playing_next_round")
            players.append({
                "id": p["id"], "name": p["web_name"],
                "full_name": f"{p['first_name']} {p['second_name']}",
                "team": team["name"], "team_short": team["short"], "team_id": p["team"],
                "position": POSITION_MAP.get(p["element_type"], "?"),
                "now_cost": round(p["now_cost"] / 10, 1),
                "total_points": int(p.get("total_points") or 0),
                "points_per_game": _num(p.get("points_per_game")),
                "form": _num(p.get("form")),
                "ep_next": _num(p.get("ep_next")),
                "selected_by": _num(p.get("selected_by_percent")),
                "minutes": int(p.get("minutes") or 0),
                "starts": int(p.get("starts") or 0),
                "goals": int(p.get("goals_scored") or 0),
                "assists": int(p.get("assists") or 0),
                "clean_sheets": int(p.get("clean_sheets") or 0),
                "bonus": int(p.get("bonus") or 0),
                "xg": _num(p.get("expected_goals")),
                "xa": _num(p.get("expected_assists")),
                "xgc": _num(p.get("expected_goals_conceded")),
                "ict_index": _num(p.get("ict_index")),
                "transfers_in_event": int(p.get("transfers_in_event") or 0),
                "transfers_out_event": int(p.get("transfers_out_event") or 0),
                "status": p.get("status", "a"),
                "chance_of_playing": None if cop is None else int(cop),
                "news": p.get("news") or "",
                "fixtures": upcoming,
                "next_fixture": _fixture_label(next_gw_fx),
            })
        print(f"[FPL] Fetched {len(players)} players, planning for GW{gw['next_gw']}")
        return {"players": players, "teams": list(teams.values()), "gameweek": gw}
    finally:
        session.close()


def fetch_player_data(horizon: int = 5) -> list:
    """Backward-compatible helper: just the player list."""
    return fetch_fpl_data(horizon)["players"]


def fetch_manager_team(entry_id: int, gameweek: int | None = None) -> dict:
    """Fetch a manager's latest 15 picks and bank.

    Uses the most recent gameweek the manager has picks for (the next GW's
    picks are private until its deadline passes).
    """
    session = _get_session_with_retries()
    try:
        entry = _get_json(session, f"{BASE_URL}/entry/{entry_id}/")
        gw = gameweek or entry.get("current_event")
        if not gw:
            raise ValueError(f"Manager {entry_id} has no gameweek picks yet")
        picks = _get_json(session, f"{BASE_URL}/entry/{entry_id}/event/{gw}/picks/")
        hist = picks.get("entry_history") or {}
        return {
            "entry_id": entry_id,
            "manager": f"{entry.get('player_first_name', '')} {entry.get('player_last_name', '')}".strip(),
            "team_name": entry.get("name", ""),
            "gameweek": gw,
            "overall_rank": entry.get("summary_overall_rank"),
            "overall_points": entry.get("summary_overall_points"),
            "bank": round((hist.get("bank") or entry.get("last_deadline_bank") or 0) / 10, 1),
            "team_value": round((hist.get("value") or entry.get("last_deadline_value") or 0) / 10, 1),
            "picks": [p["element"] for p in picks.get("picks", [])],
        }
    finally:
        session.close()
