# FPL AI Analyzer — Chrome extension

The whole analyzer running in your browser, connected to your Fantasy Premier League account.
No Python, no server.

## Install (developer mode)
1. Download this folder (or the `fpl-ai-chrome-extension.zip` release) and unzip it.
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `chrome-extension` folder.
4. Pin **FPL AI** from the puzzle-piece menu.

## Connect your FPL account
Open [fantasy.premierleague.com](https://fantasy.premierleague.com/my-team) and log in as usual.
The extension notices the login automatically — press **Refresh** in the popup and your team appears.

Connected, you get things public data can't show:
- your **real selling prices** (transfer budgets are exact)
- **free transfers** (double-transfer plans when you have 2+)
- **chips** still available

Not logged in? Type any team ID in the dashboard to analyse it from public data.

## Let it make the changes for you
Pick a suggestion and the extension saves it to your real team — after a confirmation that shows exactly what changes:

- **Apply best lineup** — best XI, bench order, captain and vice-captain. It reads your team back afterwards to check FPL saved it.
- **Make transfer / Make both** — uses your real selling prices, warns about any points hit, then saves the best lineup and
  captain for the new squad. Transfers can't be undone, so the confirmation says so.
- **Autopilot lineup** (Settings, off by default) — before each deadline, saves the best XI and captain whenever it's at least
  0.5 xP better. It never makes transfers.

## FPL Draft
Open [draft.premierleague.com](https://draft.premierleague.com) once while logged in and your Draft team is picked up
automatically (or enter your Draft team ID in Settings). The **Draft** tab shows:

- **Best Draft XI** from your squad, with *Apply best lineup*
- **Waiver & free-agent targets** — unowned players that improve your best XI, labelled waiver or free agent,
  with *Submit waiver claim* / *Sign now*
- **Best free agents** by position
- **Big board** for draft day — players ranked by value over replacement for your league size, taken players greyed out,
  plus your best next pick given the positions you still need

Saving to Draft is **experimental**: FPL Draft's save requests aren't publicly documented. If Draft refuses a change,
nothing is changed and the right Draft page opens so you can do it there.

## What you get
- **Popup** — your captain, transfer advice, injured starters, best captain overall, differentials
- **Dashboard** — Overview · My team (pitch view, single & double transfers) · Optimal squad (wildcard/free-hit planner) ·
  Fixture ticker · Player table (search, filter, sort) · Settings (horizon, budget)
- **Toolbar badge** — hours to the deadline when it's under 48h; orange if someone in your XI is flagged
- Data refreshes every 3 hours in the background

## Privacy
Nothing is ever changed on your team without you confirming it (or turning on autopilot).
The FPL login token is read from the requests FPL's own site makes, kept in memory only
(`chrome.storage.session`, cleared when Chrome closes) and sent only to fantasy.premierleague.com.
The extension has no server and no analytics. Settings → **Forget FPL login** clears it immediately.

Permissions: `webRequest` (to see the FPL login header), `storage`, `alarms`, `scripting` (to save Draft changes
from a Draft tab, using your Draft login), and access to `fantasy.premierleague.com` and `draft.premierleague.com` only.

## How it works
`lib/core.js` is a JavaScript port of the Python package in this repo — the same expected-points model,
exact squad optimiser (integer programming via the bundled public-domain
[javascript-lp-solver](https://github.com/JWally/jsLPSolver)) and transfer logic. The tests check it
produces the same optimal squads as the Python/SciPy version.

```
node --test tests/*.test.mjs     # or: npm test
```

FPL's login scheme is unofficial and may change; if connecting stops working, public mode (team ID) still works.
