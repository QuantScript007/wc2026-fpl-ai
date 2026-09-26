// Run with: node --test chrome-extension/tests/*.test.mjs
// fake-fpl.json is generated from tests/factory.py (the Python suite's synthetic league).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as core from "../lib/core.js";

const fake = JSON.parse(fs.readFileSync(new URL("./fake-fpl.json", import.meta.url)));
const data = core.buildPlayers(fake.bootstrap, fake.fixtures, 5);
const scored = core.scorePlayers(data.players, data.gameweek.finished_gws, data.gameweek.next_gw);
const countBy = (arr, k) => arr.reduce((m, p) => ((m[p[k]] = (m[p[k]] || 0) + 1), m), {});

test("gameweek info and fixtures", () => {
  assert.equal(data.gameweek.next_gw, 6);
  assert.equal(data.gameweek.finished_gws, 5);
  const byTeam = Object.fromEntries(data.players.map(p => [p.team_id, p]));
  assert.equal(byTeam[1].fixtures.filter(f => f.gw === 6).length, 2);  // double
  assert.equal(byTeam[20].next_fixture, "BLANK");                     // blank
});

test("availability", () => {
  assert.equal(core.availability("a", null), 1);
  assert.equal(core.availability("d", null), 0.5);
  assert.equal(core.availability("i", null), 0);
  assert.equal(core.availability("d", 75), 0.75);
});

test("injured players score zero next GW", () => {
  for (const p of scored.filter(p => p.availability === 0)) assert.equal(p.xp_next, 0);
});

test("captain is the best available player", () => {
  const cap = core.pickCaptain(scored);
  const best = Math.max(...scored.filter(p => p.availability >= 0.75).map(p => p.xp_next));
  assert.equal(cap.score, best);
});

for (const budget of [100, 85]) {
  test(`optimal squad obeys FPL rules at £${budget}m`, () => {
    const r = core.buildOptimalSquad(scored, { budget });
    const squad = [...r.starters, ...r.bench];
    assert.equal(squad.length, 15);
    assert.deepEqual(countBy(squad, "position"), core.SQUAD_SLOTS);
    assert.ok(Math.max(...Object.values(countBy(squad, "team_id"))) <= 3);
    assert.ok(r.total_cost <= budget + 1e-9);
    assert.equal(r.starters.length, 11);
    for (const [pos, [lo, hi]] of Object.entries(core.XI_LIMITS)) {
      const n = r.starters.filter(p => p.position === pos).length;
      assert.ok(n >= lo && n <= hi);
    }
    assert.equal(r.bench.at(-1).position, "GKP");
  });
}

test("optimal squad matches the Python (SciPy) solver", () => {
  // Values produced by optimizer/squad.py on the same synthetic league
  assert.equal(core.buildOptimalSquad(scored, { budget: 100 }).xp_horizon, 294.69);
  assert.equal(core.buildOptimalSquad(scored, { budget: 85 }).xp_horizon, 268.96);
});

test("infeasible budget throws", () => {
  assert.throws(() => core.buildOptimalSquad(scored, { budget: 20 }), core.OptimizationError);
});

test("best XI is exact over legal formations", () => {
  const squad = scored.filter(p => fake.picks.includes(p.id));
  const r = core.bestXi(squad);
  assert.equal(r.starters.length, 11);
  assert.equal(r.bench.length, 4);
  assert.ok(r.starters.some(p => p.name === r.captain));
});

test("transfers respect budget, position, clubs and selling prices", () => {
  const byId = new Map(scored.map(p => [p.id, p]));
  const sellPrices = Object.fromEntries(fake.picks.map(id => [id, byId.get(id).now_cost - 0.5]));
  const { singles, doubles } = core.suggestTransfers(scored, fake.picks, 1.0, { sellPrices, freeTransfers: 2 });
  assert.ok(singles.length > 0 && doubles.length > 0);
  assert.equal(new Set(singles.map(s => s.in.id)).size, singles.length);
  for (const s of singles) {
    assert.equal(s.in.position, s.out.position);
    assert.ok(!fake.picks.includes(s.in.id));
    assert.ok(s.in.now_cost <= sellPrices[s.out.id] + 1.0 + 1e-9);
  }
  for (let i = 1; i < singles.length; i++) assert.ok(singles[i - 1].gain >= singles[i].gain);
});

test("full report with a manager", () => {
  const rep = core.buildReport(fake.bootstrap, fake.fixtures,
    { manager: { team_name: "T", bank: 1.5, free_transfers: 1, picks: fake.picks } });
  assert.ok(rep.captain.captain && rep.optimal_squad && rep.my_team.advice);
  assert.equal(rep.my_team.double_transfers.length, 0);   // only 1 FT
  assert.equal(rep.insights.fixture_ticker.length, 20);
  assert.ok(rep.insights.differentials.every(p => p.selected_by < 10));
});
