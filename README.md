# ⚽ FPL AI Analyzer

A Fantasy Premier League assistant: expected-points model, exact squad optimiser,
captain picks, transfer suggestions for **your** team, and a web dashboard.
Optional daily Telegram summary.

**Prefer your browser?** [`chrome-extension/`](chrome-extension/) is the same analyzer as a Chrome extension
that connects to your FPL login (real selling prices, free transfers, chips) — no Python needed.

## Quick start
```
pip install -r requirements.txt
cp .env.example .env          # optional: add FPL_TEAM_ID and Telegram keys
python main.py --once         # fetch + analyse now  → data/player_scores.json
python app.py                 # dashboard            → http://localhost:5051
```
Windows: double-click `start_fpl.bat`.

`python main.py` (without `--once`) runs now and then daily at `FPL_RUN_AT` (default 09:00).

| Flag | Env var | Default | Meaning |
|------|---------|---------|---------|
| `--team 123456` | `FPL_TEAM_ID` | – | Analyse your own squad |
| `--horizon 5` | `FPL_HORIZON` | 5 | Gameweeks to plan ahead |
| `--budget 100` | – | 100.0 | Budget for the optimal squad |
| `--at 09:00` | `FPL_RUN_AT` | 09:00 | Daily run time |
| `--once` | – | – | Run once and exit |

Your team ID is in the URL of your Points page: `fantasy.premierleague.com/entry/<ID>/event/…`.
You can also type it into the dashboard and press **Refresh**.

## What it does

**Expected points (`models/expected_points.py`)** — per-match estimate blending
- an xG / xA model using FPL scoring rules per position, Poisson clean-sheet odds from xGC, bonus rate and minutes share
- recent form, season points-per-game, and FPL's own `ep_next`

then scaled by **availability** (injury/doubt flags) and **fixture difficulty** (FPL's FDR + home advantage).
Double gameweeks count twice, blanks count zero. Outputs `xp_next`, `xp_horizon` and `value` (xP per £m).

**Optimal squad (`optimizer/squad.py`)** — exact integer programming (SciPy/HiGHS) with the real rules:
2 GKP / 5 DEF / 5 MID / 3 FWD, max 3 per club, within budget, valid formation for the XI. Use it as a
Wildcard / Free Hit planner.

**Your team (`analysis/insights.py`)** — best XI and captain from your 15, flagged players, and the top
single transfers ranked by gain in best-XI expected points (respecting bank and the 3-per-club rule).
Suggests rolling the transfer when nothing gains more than 2 pts.

**Market insights** — differentials (<10% owned), best value per position, fixture ticker,
most transferred in/out, injury watch among popular players.

## Dashboard
Tabs: Overview · My team (pitch view + transfers) · Optimal squad · Fixtures (FDR ticker) · Players
(search, filter, sort). Works on mobile.

API: `GET /api/data`, `POST /api/refresh {"team_id": 123456}`, `GET /api/status`.

## Tests
```
pip install -r requirements-test.txt && pytest
```
All HTTP is mocked with a synthetic 20-club league (including a double and a blank gameweek) — no network needed.

## Structure
```
scrapers/fpl.py            FPL API: players, gameweeks, fixtures+FDR, manager picks
models/expected_points.py  expected-points model
models/captain.py          captain / vice-captain
optimizer/squad.py         integer-programming squad & XI optimiser
analysis/insights.py       my-team analysis, transfers, market insights
notifications/telegram.py  Telegram send()
main.py                    pipeline + scheduler CLI
app.py, dashboard/         Flask server + single-page dashboard
```

## Notes
- Selling prices aren't public, so transfer budgets use current prices; your in-game budget may be slightly lower.
- A manager's picks for the upcoming gameweek are private until its deadline, so the analysis uses the latest published picks.

MIT License
