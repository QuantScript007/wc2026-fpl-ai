from flask import Flask, jsonify, send_from_directory
import json
from pathlib import Path

BASE      = Path(__file__).parent
DATA_FILE = BASE / "data" / "player_scores.json"
app       = Flask(__name__)


def load_data():
    if DATA_FILE.exists():
        with open(DATA_FILE) as f:
            return json.load(f)
    return {"updated": "Run main.py first", "captain": {}, "top_players": [], "total_players": 0, "xi": [], "subs": []}


@app.route("/")
def index():
    return send_from_directory(str(BASE / "dashboard"), "index.html")

@app.route("/api/data")
def api_data():
    return jsonify(load_data())


if __name__ == "__main__":
    print("[FPL] Dashboard -> http://localhost:5051")
    app.run(host="0.0.0.0", port=5051, debug=False)
