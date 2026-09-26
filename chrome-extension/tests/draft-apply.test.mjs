// Tests for lineup changes, the save payloads, and the FPL Draft engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as core from "../lib/core.js";

const fake = JSON.parse(fs.readFileSync(new URL("./fake-fpl.json", import.meta.url)));
const data = core.buildPlayers(fake.bootstrap, fake.fixtures, 5);
const scored = core.scorePlayers(data.players, data.gameweek.finished_gws, data.gameweek.next_gw);
const byId = new Map(scored.map(p => [p.id, p]));
const squad = fake.picks.map(id => byId.get(id));
const best = core.bestXi(squad);

// ---- classic: lineup comparison + payloads -------------------------------------

test("compareLineup finds gain and the changes", () => {
  const worst = [...squad].sort((a, b) => a.xp_next - b.xp_next);
  const gk = squad.filter(p => p.position === "GKP").sort((a, b) => a.xp_next - b.xp_next)[0];
  // a legal but poor lineup: worst GK + 4 DEF, 4 MID, 2 FWD picked from the bottom
  const pick = (pos, n) => worst.filter(p => p.position === pos).slice(0, n).map(p => p.id);
  const starters = [gk.id, ...pick("DEF", 4), ...pick("MID", 4), ...pick("FWD", 2)];
  const current = { starters, bench: fake.picks.filter(id => !starters.includes(id)), captain: starters[1], vice_captain: starters[2] };
  const diff = core.compareLineup(scored, current, best);
  assert.ok(diff.gain > 0);
  assert.ok(diff.changes.some(c => c.startsWith("Captain")));
  assert.equal(diff.best_xp, best.xp_next);
});

test("compareLineup is zero when already optimal", () => {
  const cur = { starters: best.starters.map(p => p.id), bench: best.bench.map(p => p.id),
                captain: best.starters.find(p => p.name === best.captain).id,
                vice_captain: best.starters.find(p => p.name === best.vice_captain).id };
  const diff = core.compareLineup(scored, cur, best);
  assert.equal(diff.gain, 0);
  assert.deepEqual(diff.changes, []);
});

test("lineup payload follows FPL's format", () => {
  const body = core.lineupPayload(best);
  assert.equal(body.chip, null);
  assert.equal(body.picks.length, 15);
  assert.deepEqual(body.picks.map(p => p.position), [...Array(15).keys()].map(i => i + 1));
  const at = pos => byId.get(body.picks[pos - 1].element).position;
  assert.equal(at(1), "GKP");
  assert.equal(at(12), "GKP");                                 // bench GK in slot 12
  assert.equal(body.picks.filter(p => p.is_captain).length, 1);
  assert.equal(body.picks.filter(p => p.is_vice_captain).length, 1);
  assert.ok(body.picks.slice(0, 11).some(p => p.is_captain));   // captain is a starter
});

test("draft lineup payload has no captain fields", () => {
  const body = core.lineupPayload(best, false);
  assert.deepEqual(Object.keys(body.picks[0]).sort(), ["element", "position"]);
  assert.deepEqual(body.subs, []);
});

test("transfer payload uses tenths and real selling prices", () => {
  const [out, inc] = [squad[5], scored.find(p => p.position === squad[5].position && !fake.picks.includes(p.id))];
  const body = core.transferPayload({ entry: 42, event: 6, moves: [{ out, in: inc }], sellPrices: { [out.id]: 4.3 } });
  assert.deepEqual(body, { confirmed: true, entry: 42, event: 6, chip: null,
    transfers: [{ element_in: inc.id, element_out: out.id, purchase_price: Math.round(inc.now_cost * 10), selling_price: 43 }] });
});

test("transfer cost: hits and bank", () => {
  const mv = (o, i) => ({ out: { id: 1, now_cost: o }, in: { id: 2, now_cost: i } });
  assert.deepEqual(core.transferCost([mv(5, 6)], { bank: 1.5, freeTransfers: 1 }), { bank_after: 0.5, hit: 0, affordable: true });
  assert.equal(core.transferCost([mv(5, 6), mv(5, 5)], { bank: 1.5, freeTransfers: 1 }).hit, 4);
  assert.equal(core.transferCost([mv(5, 6), mv(5, 5)], { bank: 1.5, freeTransfers: 1, unlimited: true }).hit, 0);
  assert.equal(core.transferCost([mv(5, 7)], { bank: 1.5, freeTransfers: 1 }).affordable, false);
  assert.equal(core.transferCost([mv(5, 6)], { bank: 0, freeTransfers: 1, sellPrices: { 1: 6 } }).affordable, true);
});

// ---- draft ------------------------------------------------------------------

// Draft-shaped payloads built from the same synthetic league
const draftBootstrap = {
  teams: fake.bootstrap.teams,
  elements: fake.bootstrap.elements.map(({ now_cost, selected_by_percent, ...e }, i) => ({ ...e, draft_rank: i + 1 })),
  events: { current: 5, next: 6, data: fake.bootstrap.events.map(({ is_next, is_current, ...e }) => e) },
};
// classic fixtures use shuffled club ids to prove mapping by short name works
const classicTeams = fake.bootstrap.teams.map(t => ({ ...t, id: 21 - t.id }));
const classicFixtures = fake.fixtures.map(f => ({ ...f, team_h: 21 - f.team_h, team_a: 21 - f.team_a }));
const owned = new Set(fake.picks);
const elementStatus = draftBootstrap.elements.map(e => ({
  element: e.id, owner: owned.has(e.id) ? 42 : (e.id % 3 === 0 ? 7 : null),
  status: owned.has(e.id) || e.id % 3 === 0 ? "o" : (e.id % 3 === 1 ? "a" : "w") }));
const ctx = { entry: { id: 42 }, picks: fake.picks, elementStatus,
  league: { league: { id: 9, name: "Mates", draft_status: "post" }, league_entries: Array(10).fill({}) } };

test("draft bootstrap is normalised and fixtures map by short name", () => {
  const { bootstrap, fixtures } = core.normalizeDraftBootstrap(draftBootstrap, classicFixtures, classicTeams);
  assert.ok(bootstrap.events.find(e => e.is_next).id === 6);
  assert.deepEqual(fixtures.slice(0, 3).map(f => [f.team_h, f.team_a]), fake.fixtures.slice(0, 3).map(f => [f.team_h, f.team_a]));
  const players = core.buildPlayers(bootstrap, fixtures).players;
  assert.ok(players.every(p => p.now_cost === 0));
  // same fixtures as the classic data for every club
  const classic = new Map(data.players.map(p => [p.id, p.next_fixture]));
  assert.ok(players.every(p => p.next_fixture === classic.get(p.id)));
});

test("draft report: lineup, waiver/free-agent moves, free agents", () => {
  const r = core.buildDraftReport(draftBootstrap, classicFixtures, classicTeams, ctx);
  assert.equal(r.lineup.starters.length, 11);
  assert.equal(r.lineup.captain, null);                       // no captains in Draft
  assert.ok(r.moves.length > 0);
  for (const m of r.moves) {
    assert.ok(!owned.has(m.in.id) && owned.has(m.out.id));
    assert.equal(m.in.position, m.out.position);
    assert.equal(elementStatus.find(s => s.element === m.in.id).owner, null);
    assert.equal(m.kind, m.in.id % 3 === 1 ? "free agent" : "waiver");
    assert.ok(m.gain > 0);
  }
  for (const pos of core.POSITIONS) assert.ok(r.free_agents[pos].every(p => !owned.has(p.id) && p.id % 3 !== 0));
  assert.equal(r.next_pick, null);                            // draft finished
  assert.equal(r.league.size, 10);
});

test("big board ranks by value over replacement and marks taken players", () => {
  const board = core.draftBigBoard(scored, { leagueSize: 8, taken: new Set([board0()]) });
  function board0() { return core.draftBigBoard(scored)[0].id; }
  assert.ok(board[0].taken);
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].vorp >= board[i].vorp);
  assert.deepEqual(board.slice(0, 3).map(p => p.board_rank), [1, 2, 3]);
});

test("next draft pick respects positions you still need", () => {
  const board = core.draftBigBoard(scored);
  const gks = board.filter(p => p.position === "GKP").slice(0, 2).map(p => p.id);
  const pick = core.nextDraftPick(board, gks);                // already have 2 GKs
  assert.notEqual(pick.position, "GKP");
  assert.equal(core.nextDraftPick(board, []).id, board[0].id);
});

test("pre-draft league suggests a pick", () => {
  const r = core.buildDraftReport(draftBootstrap, classicFixtures, classicTeams,
    { ...ctx, picks: [], elementStatus: [], league: { league: { draft_status: "pre" }, league_entries: [] } });
  assert.ok(r.next_pick && r.lineup === null && r.moves.length === 0);
});

test("draft moves drop the same player at most 3 times", () => {
  const r = core.buildDraftReport(draftBootstrap, classicFixtures, classicTeams, ctx);
  const outs = {};
  for (const m of r.moves) outs[m.out.id] = (outs[m.out.id] || 0) + 1;
  assert.ok(Math.max(...Object.values(outs)) <= 3);
});
