"""FPL AI dashboard server."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

import main as analyzer

BASE      = Path(__file__).parent
DATA_FILE = analyzer.DATA_FILE
app       = Flask(__name__)
_refresh_lock = threading.Lock()
_status = {"running": False, "error": None}

EMPTY = {"updated": None, "gameweek": {}, "captain": {}, "optimal_squad": None,
         "insights": {}, "players": [], "my_team": None, "total_players": 0}


def load_data() -> dict:
    if DATA_FILE.exists():
        with open(DATA_FILE) as f:
            return json.load(f)
    return dict(EMPTY, updated="No data yet - press Refresh or run main.py")


def _refresh(team_id: int | None, horizon: int) -> None:
    try:
        report = analyzer.run(team_id=team_id, horizon=horizon, notify=False)
        _status["error"] = None if report else "Could not reach the FPL API"
    except Exception as e:  # surface to the dashboard instead of dying silently
        _status["error"] = str(e)
    finally:
        _status["running"] = False
        _refresh_lock.release()


@app.route("/")
def index():
    return send_from_directory(str(BASE / "dashboard"), "index.html")


@app.route("/api/data")
def api_data():
    return jsonify(load_data())


@app.route("/api/status")
def api_status():
    return jsonify(_status)


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    body = request.get_json(silent=True) or {}
    team = body.get("team_id") or analyzer._env_int("FPL_TEAM_ID", None)
    try:
        team = int(team) if team else None
    except (TypeError, ValueError):
        return jsonify({"started": False, "error": "Team ID must be a number"}), 400
    horizon = int(body.get("horizon") or analyzer._env_int("FPL_HORIZON", 5))
    if not _refresh_lock.acquire(blocking=False):
        return jsonify({"started": False, "error": "A refresh is already running"}), 409
    _status.update(running=True, error=None)
    threading.Thread(target=_refresh, args=(team, horizon), daemon=True).start()
    return jsonify({"started": True})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5051"))
    print(f"[FPL] Dashboard -> http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
