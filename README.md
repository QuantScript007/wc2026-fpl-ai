# ⚽ WC2026 + FPL AI Dashboard

Two Flask apps, modular Python, 35 pytest tests, Telegram alerts.

| App | Port | Description |
|-----|------|-------------|
| WC2026 Dashboard | :5050 | Fixtures, standings, ML predictions, Fantasy XV |
| FPL Bot + Dashboard | :5051 | Captain picks, Best XI, daily alerts |

## Quick Start
```
pip install -r requirements.txt
cp .env.example .env
python wc2026_app.py   # → http://localhost:5050
python main.py         # FPL data (daily 09:00)
python app.py          # → http://localhost:5051
```
Windows: double-click start_wc2026.bat or start_fpl.bat

## Tests
```
pip install pytest && pytest
```
35 tests, all mock HTTP — no network needed.

## Structure
```
scrapers/   ESPN & FPL API clients
models/     RandomForest WC predictor, captain model, performance model
optimizer/  Best XI builder, Fantasy XV selector
notifications/ Telegram send() helper
tests/      pytest unit tests
dashboard/  HTML frontends (served by Flask)
```

## API
WC2026 :5050 — /api/all, /api/fixtures, /api/standings, /api/predictions,
               /api/fantasy, /api/predict/{home}/{away}, /api/refresh
FPL    :5051 — /api/data

## ML
- WC predictor: RandomForest 300 trees, FIFA rankings + confederation strength
- FPL captain: goals×4 + assists×3 + minutes×0.02 + form×5 + pts×0.1
- Fantasy XV: GK×2 DEF×5 MID×5 FWD×3, max 3/nation, no injured players

MIT License
