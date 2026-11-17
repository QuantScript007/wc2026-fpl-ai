"""SQLite storage for bot users, Stars payments and sent alerts."""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    chat_id       INTEGER NOT NULL,
    first_name    TEXT,
    team_id       INTEGER,
    premium_until INTEGER NOT NULL DEFAULT 0,
    created       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
    charge_id   TEXT PRIMARY KEY,          -- telegram_payment_charge_id
    user_id     INTEGER NOT NULL,
    amount      INTEGER NOT NULL,          -- Stars
    payload     TEXT NOT NULL,
    days        INTEGER NOT NULL,
    created     INTEGER NOT NULL,
    refunded    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sent (
    key     TEXT PRIMARY KEY,
    created INTEGER NOT NULL
);
"""
DAY = 86400


class Store:
    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    # ---------------------------------------------------------------- users --
    def touch_user(self, user_id: int, chat_id: int, first_name: str = "") -> None:
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO users (user_id, chat_id, first_name, created) VALUES (?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, first_name=excluded.first_name",
                (user_id, chat_id, first_name, int(time.time())))

    def user(self, user_id: int) -> dict | None:
        row = self.db.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone()
        return dict(row) if row else None

    def set_team(self, user_id: int, team_id: int | None) -> None:
        with self.lock, self.db:
            self.db.execute("UPDATE users SET team_id=? WHERE user_id=?", (team_id, user_id))

    def premium_until(self, user_id: int) -> int:
        u = self.user(user_id)
        return u["premium_until"] if u else 0

    def is_premium(self, user_id: int, now: float | None = None) -> bool:
        return self.premium_until(user_id) > (now or time.time())

    def premium_users(self, now: float | None = None) -> list[dict]:
        rows = self.db.execute("SELECT * FROM users WHERE premium_until > ?", (int(now or time.time()),))
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- payments --
    def record_payment(self, charge_id: str, user_id: int, amount: int, payload: str,
                       days: int, now: float | None = None) -> int | None:
        """Store a payment and extend Premium. Returns the new expiry, or None if
        this charge was already recorded (Telegram can resend updates)."""
        now = int(now or time.time())
        with self.lock, self.db:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO payments (charge_id, user_id, amount, payload, days, created) "
                "VALUES (?,?,?,?,?,?)", (charge_id, user_id, amount, payload, days, now))
            if cur.rowcount == 0:
                return None
            row = self.db.execute("SELECT premium_until FROM users WHERE user_id=?", (user_id,)).fetchone()
            start = max(now, row["premium_until"] if row else 0)
            until = start + days * DAY
            self.db.execute("UPDATE users SET premium_until=? WHERE user_id=?", (until, user_id))
            return until

    def payment(self, charge_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM payments WHERE charge_id=?", (charge_id,)).fetchone()
        return dict(row) if row else None

    def last_payment(self, user_id: int) -> dict | None:
        row = self.db.execute("SELECT * FROM payments WHERE user_id=? AND refunded=0 "
                              "ORDER BY created DESC LIMIT 1", (user_id,)).fetchone()
        return dict(row) if row else None

    def mark_refunded(self, charge_id: str, now: float | None = None) -> None:
        """Flag the payment and take its days back off the user's Premium."""
        now = int(now or time.time())
        with self.lock, self.db:
            p = self.db.execute("SELECT * FROM payments WHERE charge_id=?", (charge_id,)).fetchone()
            if not p or p["refunded"]:
                return
            self.db.execute("UPDATE payments SET refunded=1 WHERE charge_id=?", (charge_id,))
            row = self.db.execute("SELECT premium_until FROM users WHERE user_id=?", (p["user_id"],)).fetchone()
            if row:
                until = max(now, row["premium_until"] - p["days"] * DAY)
                self.db.execute("UPDATE users SET premium_until=? WHERE user_id=?", (until, p["user_id"]))

    # ---------------------------------------------------------------- alerts --
    def mark_sent(self, key: str) -> bool:
        """Remember an alert. Returns False if it was already sent."""
        with self.lock, self.db:
            cur = self.db.execute("INSERT OR IGNORE INTO sent (key, created) VALUES (?,?)",
                                  (key, int(time.time())))
            return cur.rowcount == 1
