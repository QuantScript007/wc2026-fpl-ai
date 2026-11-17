# ⚽ FPL AI Analyzer

A Fantasy Premier League assistant: expected-points model, exact squad optimiser,
captain picks, transfer suggestions for **your** team, and a web dashboard.
Optional daily Telegram summary.

**Prefer your browser?** [`chrome-extension/`](chrome-extension/) is the same analyzer as a Chrome extension
that connects to your FPL login (real selling prices, free transfers, chips), supports **FPL Draft**,
and can **apply the best lineup and transfers to your team** for you — no Python needed.

## Telegram bot with Stars Premium (free hosting)
The **FPL AI bot** runs free on **Cloudflare Workers**, and **GitHub Actions** runs the analysis every hour. No server needed.

- Free: `/captain`, `/differentials`, `/team <id>`
- **Premium** for Telegram Stars (default ⭐150 / 30 days): `/myteam`, deadline alerts 24h and 2h before each
  deadline, and a key that unlocks the Chrome extension's Premium features
- Payments follow Telegram's Stars rules: invoices in `XTR`, instant pre-checkout answer, `/terms`, `/paysupport`.
  Admins: `/refund <payment ID>`, `/reply <user ID> <text>`, `/stats`

How it fits together:
```
Telegram ──webhook──▶ Cloudflare Worker (worker/) ──▶ D1 database (users, payments)
                              ▲ every hour: captain, differentials, Premium team reports
GitHub Actions (fpl-bot-data.yml) runs stars_bot/publish.py with the Python analyzer
```

### Set up (works from a phone)
1. **Bot:** in Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
   Message [@userinfobot](https://t.me/userinfobot) to get your own Telegram ID.
2. **Cloudflare** (free account at dash.cloudflare.com):
   - Open **Workers & Pages** once, so your `workers.dev` subdomain gets created.
   - Copy your **Account ID** (on the Workers & Pages overview page).
   - **My Profile → API Tokens → Create Token →** template **Edit Cloudflare Workers** → add permission
     **Account · D1 · Edit** → create → copy the token.
3. **GitHub:** repo **Settings → Secrets and variables → Actions**.
   - **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`
   - **Variables:** `ADMIN_IDS` = your Telegram ID. Optional: `STARS_PRICE`, `PREMIUM_DAYS`, `SUPPORT_CONTACT`, `EXTENSION_URL`
4. **Actions → Deploy bot → Run workflow.** It creates the database, deploys the Worker, connects Telegram,
   and commits the extension's public key (`chrome-extension/lib/licence-config.js`). It then starts the first data upload.
5. Message your bot `/start`. Reload the extension so it picks up the key.

Scheduled workflows only run on the repository's **default branch**, so keep this code there.
Stars collect in the bot's balance; withdraw them via [Fragment](https://fragment.com) from the bot's settings in Telegram.

Free-plan headroom: 100,000 Telegram updates a day. Alerts go out at up to 40 messages every 5 minutes.

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
stars_bot/                 hourly publisher for the Telegram bot (messages, publish)
worker/                    Telegram bot on Cloudflare Workers: Stars payments, keys, alerts
main.py                    pipeline + scheduler CLI
app.py, dashboard/         Flask server + single-page dashboard
```

## Notes
- Selling prices aren't public, so transfer budgets use current prices; your in-game budget may be slightly lower.
- A manager's picks for the upcoming gameweek are private until its deadline, so the analysis uses the latest published picks.

MIT License
