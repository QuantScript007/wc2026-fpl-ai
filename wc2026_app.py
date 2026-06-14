"""WC2026 Flask app -- thin route layer, all logic lives in modules."""
import json, time, threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, send_from_directory

from scrapers.espn        import fetch_teams, fetch_squad, fetch_fixtures, fetch_standings
from models.wc_predictor  import WCPredictor
from optimizer.fantasy_xv import select_fantasy_xv

CACHE_FILE = Path("data/wc2026_cache.json")
CACHE_MAX  = 3600
app        = Flask(__name__)
predictor  = WCPredictor()


def build_cache() -> dict:
    """Fetch all live data and write to disk cache."""
    print("[WC] Building cache...")
    teams  = fetch_teams()
    squads = {}
    for i, t in enumerate(teams):
        squads[t["id"]] = fetch_squad(t["id"])
        print(f"  [{i+1}/{len(teams)}] {t['name']}")
        time.sleep(0.12)
    fx    = fetch_fixtures()
    st    = fetch_standings()
    preds = predictor.predict_fixtures(fx)
    fan   = select_fantasy_xv(teams, squads)
    cache = {
        "updated":     datetime.now(timezone.utc).isoformat(),
        "teams":       teams,
        "squads":      squads,
        "fixtures":    fx,
        "standings":   st,
        "predictions": preds,
        "fantasy":     fan,
    }
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, default=str)
    print(f"[WC] Done | {len(teams)} teams | {len(fx)} fixtures")
    return cache


_cache: dict = {}
_lock = threading.Lock()


def get_cache() -> dict:
    global _cache
    with _lock:
        if not _cache:
            if CACHE_FILE.exists() and time.time() - CACHE_FILE.stat().st_mtime < CACHE_MAX:
                with open(CACHE_FILE) as f:
                    _cache = json.load(f)
            else:
                _cache = build_cache()
    return _cache


@app.route("/")
def index(): return send_from_directory("dashboard", "wc2026.html")
@app.route("/api/teams")
def api_teams(): return jsonify(get_cache().get("teams", []))
@app.route("/api/squad/<tid>")
def api_squad(tid): return jsonify(get_cache().get("squads", {}).get(tid, []))
@app.route("/api/fixtures")
def api_fixtures(): return jsonify(get_cache().get("fixtures", []))
@app.route("/api/standings")
def api_standings(): return jsonify(get_cache().get("standings", []))
@app.route("/api/predictions")
def api_predictions(): return jsonify(get_cache().get("predictions", []))
@app.route("/api/fantasy")
def api_fantasy(): return jsonify(get_cache().get("fantasy", {}))
@app.route("/api/all")
def api_all():
    c = get_cache()
    return jsonify({"updated": c.get("updated"), "teams": c.get("teams", []),
                    "fixtures": c.get("fixtures", []), "standings": c.get("standings", []),
                    "predictions": c.get("predictions", []), "fantasy": c.get("fantasy", {})})
@app.route("/api/refresh")
def api_refresh():
    global _cache
    fresh = build_cache()
    with _lock: _cache = fresh
    return jsonify({"status": "ok", "updated": fresh.get("updated")})
@app.route("/api/predict/<home>/<away>")
def api_predict(home, away): return jsonify(predictor.predict(home, away))


if __name__ == "__main__":
    predictor.load_or_train()
    threading.Thread(target=get_cache, daemon=True).start()
    print("[WC] Dashboard -> http://localhost:5050")
    app.run(host="0.0.0.0", port=5050, debug=False)
