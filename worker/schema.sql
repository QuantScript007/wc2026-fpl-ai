-- FPL AI bot storage (Cloudflare D1). Safe to run again: everything is IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    chat_id       INTEGER NOT NULL,
    first_name    TEXT,
    team_id       INTEGER,
    premium_until INTEGER NOT NULL DEFAULT 0,
    created       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
    charge_id TEXT PRIMARY KEY,            -- telegram_payment_charge_id
    user_id   INTEGER NOT NULL,
    amount    INTEGER NOT NULL,            -- Stars
    payload   TEXT NOT NULL,
    days      INTEGER NOT NULL,
    created   INTEGER NOT NULL,
    refunded  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sent (           -- alerts already sent (no duplicates)
    key     TEXT PRIMARY KEY,
    created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (             -- published texts, gameweek, licence key
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL,
    updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_reports (   -- per-team advice rendered by GitHub Actions
    team_id INTEGER PRIMARY KEY,
    text    TEXT NOT NULL,
    updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_premium ON users (premium_until);
