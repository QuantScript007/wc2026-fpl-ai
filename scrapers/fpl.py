"""FPL API -- fetch player data and upcoming fixtures."""
import requests
from requests.adapters import HTTPAdapter
from requests.packages.urllib3.util.retry import Retry

FPL_API      = "https://fantasy.premierleague.com/api/bootstrap-static/"
FIXTURES_API = "https://fantasy.premierleague.com/api/fixtures/?future=1"
HEADERS      = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
POSITION_MAP = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}


def _get_session_with_retries(retries: int = 3, backoff_factor: float = 0.5):
    """Create a requests session with automatic retry logic."""
    session = requests.Session()
    retry_strategy = Retry(
        total=retries,
        backoff_factor=backoff_factor,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"]
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def _fetch_next_fixtures(teams: dict) -> dict:
    """Return {team_id: fixture_label} for the next round."""
    nxt: dict = {}
    session = _get_session_with_retries()
    try:
        resp = session.get(FIXTURES_API, headers=HEADERS, timeout=10)
        if not resp.ok:
            return nxt
        for fix in resp.json():
            h, a, gw = fix["team_h"], fix["team_a"], fix.get("event", "?")
            if h not in nxt:
                nxt[h] = f"GW{gw} vs {teams.get(a, {}).get('short', '?')} (H)"
            if a not in nxt:
                nxt[a] = f"GW{gw} vs {teams.get(h, {}).get('short', '?')} (A)"
    except Exception as e:
        print(f"[FPL] Fixture fetch failed: {e}")
    finally:
        session.close()
    return nxt


def fetch_player_data() -> list:
    """Fetch all FPL player stats with next-fixture labels."""
    session = _get_session_with_retries()
    try:
        resp = session.get(FPL_API, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        data  = resp.json()
        teams = {t["id"]: {"name": t["name"], "short": t["short_name"]} for t in data["teams"]}
        try:
            nxt = _fetch_next_fixtures(teams)
        except Exception as e:
            print(f"[FPL] Fixture fetch failed: {e}")
            nxt = {}
        players = []
        for p in data["elements"]:
            team = teams.get(p["team"], {"name": "?", "short": "?"})
            players.append({
                "id": p["id"], "name": p["web_name"],
                "full_name": f"{p['first_name']} {p['second_name']}",
                "team": team["name"], "team_short": team["short"], "team_id": p["team"],
                "position": POSITION_MAP.get(p["element_type"], "?"),
                "goals": p["goals_scored"], "assists": p["assists"], "minutes": p["minutes"],
                "total_points": p["total_points"], "now_cost": round(p["now_cost"] / 10, 1),
                "selected_by": float(p.get("selected_by_percent") or 0),
                "form": float(p.get("form") or 0),
                "next_fixture": nxt.get(p["team"], "TBC"), "status": p.get("status", "a"),
            })
        print(f"[FPL] Fetched {len(players)} players")
        return players
    except Exception as e:
        print(f"[FPL] fetch_player_data failed: {e}")
        return []
    finally:
        session.close()
