// Minimal stand-in for Cloudflare D1, backed by Node's built-in SQLite (tests only).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.run())), sqlite };
}
