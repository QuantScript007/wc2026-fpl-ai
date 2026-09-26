"""Deterministic fake FPL API payloads for tests (no network)."""
import random

TEAMS = ["ARS", "AVL", "BOU", "BRE", "BHA", "BUR", "CHE", "CRY", "EVE", "FUL",
         "LEE", "LIV", "MCI", "MUN", "NEW", "NFO", "SUN", "TOT", "WHU", "WOL"]
PER_TEAM = {1: 3, 2: 8, 3: 8, 4: 4}   # element_type -> players per club


def make_bootstrap(seed: int = 7, finished: int = 5, next_gw: int = 6) -> dict:
    rng = random.Random(seed)
    teams = [{"id": i + 1, "name": f"Club {s}", "short_name": s} for i, s in enumerate(TEAMS)]
    elements, pid = [], 1
    for t in teams:
        strength = 1.0 - (t["id"] - 1) / 25          # earlier clubs are stronger
        for etype, k in PER_TEAM.items():
            for j in range(k):
                starter = j < {1: 1, 2: 5, 3: 5, 4: 2}[etype]
                mins = rng.randint(380, 450) if starter else rng.randint(0, 150)
                att = {1: 0.0, 2: 0.08, 3: 0.3, 4: 0.5}[etype] * strength * (1.4 if j == 0 else 1.0)
                xg = round(att * mins / 90 * rng.uniform(0.6, 1.3), 2)
                xa = round(att * 0.6 * mins / 90 * rng.uniform(0.5, 1.3), 2)
                pts = int(mins / 90 * 2 + xg * 5 + xa * 3 + rng.randint(0, 6))
                status = "a"
                if rng.random() < 0.06:
                    status = rng.choice(["i", "d"])
                elements.append({
                    "id": pid, "web_name": f"{t['short_name']}{etype}{j}",
                    "first_name": "Test", "second_name": f"Player{pid}", "team": t["id"],
                    "element_type": etype,
                    "now_cost": int(40 + {1: 5, 2: 5, 3: 15, 4: 20}[etype] * strength * 2 * (1.5 if j == 0 else 1) + rng.randint(0, 5)),
                    "total_points": pts, "points_per_game": f"{pts / finished:.1f}",
                    "form": f"{max(0, pts / finished + rng.uniform(-1.5, 1.5)):.1f}",
                    "ep_next": f"{max(0, pts / finished + rng.uniform(-1, 1)):.1f}",
                    "selected_by_percent": f"{rng.uniform(0.1, 45):.1f}",
                    "minutes": mins, "starts": finished if starter else 0,
                    "goals_scored": int(xg), "assists": int(xa), "clean_sheets": rng.randint(0, 3),
                    "bonus": rng.randint(0, 6), "expected_goals": str(xg),
                    "expected_assists": str(xa),
                    "expected_goals_conceded": f"{(1.6 - strength) * mins / 90:.2f}",
                    "ict_index": "20.0", "transfers_in_event": rng.randint(0, 200000),
                    "transfers_out_event": rng.randint(0, 200000), "status": status,
                    "chance_of_playing_next_round": {"i": 0, "d": 50}.get(status),
                    "news": {"i": "Knee injury", "d": "Knock - 50% chance"}.get(status, ""),
                })
                pid += 1
    events = [{"id": g, "finished": g <= finished, "is_current": g == finished,
               "is_next": g == next_gw, "deadline_time": f"2026-10-{g:02d}T10:00:00Z"}
              for g in range(1, 39)]
    return {"teams": teams, "elements": elements, "events": events}


def make_fixtures(seed: int = 7, start_gw: int = 6, n_gws: int = 6, blank_team: int | None = 20,
                  double_team: int | None = 1) -> list:
    rng = random.Random(seed)
    fixtures = []
    ids = list(range(1, 21))
    for gw in range(start_gw, start_gw + n_gws):
        rng.shuffle(ids)
        for h, a in zip(ids[::2], ids[1::2]):
            if gw == start_gw and blank_team in (h, a):
                continue                                   # blank for this pair
            fixtures.append({"event": gw, "team_h": h, "team_a": a,
                             "team_h_difficulty": min(5, max(1, 1 + a // 4)),
                             "team_a_difficulty": min(5, max(1, 1 + h // 4))})
    if double_team:
        fixtures.append({"event": start_gw, "team_h": double_team, "team_a": 19,
                         "team_h_difficulty": 2, "team_a_difficulty": 5})
    return fixtures


def valid_picks() -> list:
    """A legal 15-man squad (2/5/5/3, max 3 per club) using make_bootstrap() ids."""
    base = lambda club: (club - 1) * 23 + 1          # 23 players per club
    off = {"GKP": 0, "DEF": 3, "MID": 11, "FWD": 19}
    plan = [("GKP", 3), ("GKP", 4), ("DEF", 5), ("DEF", 6), ("DEF", 7), ("DEF", 8), ("DEF", 9),
            ("MID", 10), ("MID", 11), ("MID", 12), ("MID", 13), ("MID", 14),
            ("FWD", 15), ("FWD", 16), ("FWD", 17)]
    return [base(club) + off[pos] for pos, club in plan]
