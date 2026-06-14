"""ESPN public API -- WC2026 teams, squads, fixtures, standings."""
import requests
from datetime import datetime, timezone

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"
ESPN_ST   = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings"
HDR       = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
WC_END    = "20260720"


def fetch_teams() -> list:
    """Fetch all WC2026 registered teams."""
    r = requests.get(f"{ESPN_BASE}/teams", headers=HDR, timeout=15)
    r.raise_for_status()
    return [{"id": t["team"]["id"], "name": t["team"]["displayName"],
             "abbr": t["team"]["abbreviation"], "color": "#" + t["team"].get("color", "1a472a")}
            for t in r.json()["sports"][0]["leagues"][0]["teams"]]


def fetch_squad(tid: str) -> list:
    """Fetch full squad roster for a team ID."""
    r = requests.get(f"{ESPN_BASE}/teams/{tid}/roster", headers=HDR, timeout=10)
    if not r.ok:
        return []
    return [{"id": a.get("id",""), "name": a.get("displayName","?"), "jersey": a.get("jersey","?"),
             "position": a.get("position",{}).get("displayName","?"),
             "pos_abbr": a.get("position",{}).get("abbreviation","?"),
             "age": a.get("age","?"), "height": a.get("displayHeight","?"),
             "citizenship": a.get("citizenshipCountry",{}).get("description","?"),
             "injured": bool(a.get("injuries"))}
            for a in r.json().get("athletes", [])]


def fetch_fixtures(live: bool = False) -> list:
    """Fetch WC2026 fixtures. live=True fetches only today's scoreboard."""
    if live:
        url = f"{ESPN_BASE}/scoreboard"
    else:
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        url   = f"{ESPN_BASE}/scoreboard?dates={today}-{WC_END}"
    r = requests.get(url, headers=HDR, timeout=15)
    r.raise_for_status()
    out = []
    for ev in r.json().get("events", []):
        comp = ev.get("competitions", [{}])[0]
        cs   = comp.get("competitors", [])
        h    = next((c for c in cs if c.get("homeAway") == "home"), {})
        a    = next((c for c in cs if c.get("homeAway") == "away"), {})
        st   = ev.get("status", {}).get("type", {})
        out.append({"id": ev["id"], "date": ev.get("date","?"),
            "home_team": h.get("team",{}).get("displayName","?"), "home_id": h.get("team",{}).get("id",""),
            "home_abbr": h.get("team",{}).get("abbreviation","?"), "home_score": h.get("score",""),
            "away_team": a.get("team",{}).get("displayName","?"), "away_id": a.get("team",{}).get("id",""),
            "away_abbr": a.get("team",{}).get("abbreviation","?"), "away_score": a.get("score",""),
            "status": st.get("description","?"), "status_state": st.get("state","pre"),
            "venue": comp.get("venue",{}).get("fullName","?"),
            "venue_city": comp.get("venue",{}).get("address",{}).get("city","?")})
    return out


def fetch_standings() -> list:
    """Fetch current group-stage standings."""
    r = requests.get(ESPN_ST, headers=HDR, timeout=15)
    r.raise_for_status()
    out = []
    for g in r.json().get("children", []):
        teams = []
        for e in g.get("standings",{}).get("entries",[]):
            t = e.get("team",{})
            s = {x["name"]: x.get("value",0) for x in e.get("stats",[])}
            teams.append({"name": t.get("displayName","?"), "abbr": t.get("abbreviation","?"),
                "id": t.get("id","?"), "color": "#"+t.get("color","1a472a"),
                "played": int(s.get("gamesPlayed",0)), "wins": int(s.get("wins",0)),
                "draws": int(s.get("ties",0)), "losses": int(s.get("losses",0)),
                "gf": int(s.get("pointsFor",0)), "ga": int(s.get("pointsAgainst",0)),
                "gd": int(s.get("pointsDifference",0)), "points": int(s.get("points",0))})
        out.append({"group": g.get("name","?"), "teams": teams})
    return out
