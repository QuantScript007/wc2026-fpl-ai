// FPL AI core -- data shaping, expected-points model, optimiser and insights.
// Pure functions (no chrome.* APIs) so it runs in the extension and in Node tests.
// Mirrors the Python package in this repo (scrapers/fpl.py, models/, optimizer/, analysis/).
import solver from "./vendor/lp-solver.mjs";

export const POSITION_MAP = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
export const POSITIONS = ["GKP", "DEF", "MID", "FWD"];
export const SQUAD_SLOTS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
export const XI_LIMITS = { GKP: [1, 1], DEF: [3, 5], MID: [2, 5], FWD: [1, 3] };
export const MAX_PER_TEAM = 3;

const GOAL_PTS = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };
const CS_PTS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };
const ASSIST_PTS = 3;
const FDR_MULT = { 1: 1.2, 2: 1.1, 3: 1.0, 4: 0.88, 5: 0.76 };
const HOME_BONUS = 0.04;
const WEIGHTS = { underlying: 0.35, form: 0.2, ppg: 0.2, ep: 0.25 };
const MIN_SAMPLE_MINUTES = 450;
const BENCH_WEIGHT = 0.1;
export const ROLL_THRESHOLD = 2.0;

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
const sum = a => a.reduce((s, x) => s + x, 0);

// ---------------------------------------------------------------- data ----

export function gameweekInfo(events = []) {
  const finished = events.filter(e => e.finished).length;
  const next = events.find(e => e.is_next) || events.find(e => !e.finished) || null;
  const current = events.find(e => e.is_current);
  return {
    next_gw: next ? next.id : null,
    next_deadline: next ? next.deadline_time : null,
    current_gw: current ? current.id : null,
    finished_gws: finished,
    total_gws: events.length,
  };
}

export function teamFixtures(fixtures, teams, startGw, horizon) {
  const out = {};
  for (const id of Object.keys(teams)) out[id] = [];
  if (startGw == null) return out;
  const last = startGw + horizon - 1;
  for (const fx of fixtures || []) {
    const gw = fx.event;
    if (gw == null || gw < startGw || gw > last) continue;
    const h = fx.team_h, a = fx.team_a;
    (out[h] ||= []).push({ gw, opponent: teams[a]?.short ?? "?", home: true, difficulty: fx.team_h_difficulty || 3 });
    (out[a] ||= []).push({ gw, opponent: teams[h]?.short ?? "?", home: false, difficulty: fx.team_a_difficulty || 3 });
  }
  for (const l of Object.values(out)) l.sort((x, y) => x.gw - y.gw);
  return out;
}

const fixtureLabel = fx => fx.length ? fx.map(f => `${f.opponent} (${f.home ? "H" : "A"})`).join(", ") : "BLANK";

/** Shape raw bootstrap-static + fixtures into player records. */
export function buildPlayers(bootstrap, fixtures, horizon = 5) {
  const teams = {};
  for (const t of bootstrap.teams) teams[t.id] = { id: t.id, name: t.name, short: t.short_name };
  const gw = gameweekInfo(bootstrap.events);
  const byTeam = teamFixtures(fixtures, teams, gw.next_gw, horizon);
  const players = bootstrap.elements.map(p => {
    const team = teams[p.team] || { name: "?", short: "?" };
    const upcoming = byTeam[p.team] || [];
    const cop = p.chance_of_playing_next_round;
    return {
      id: p.id, name: p.web_name, full_name: `${p.first_name} ${p.second_name}`,
      team: team.name, team_short: team.short, team_id: p.team,
      position: POSITION_MAP[p.element_type] || "?",
      now_cost: r1(num(p.now_cost) / 10), total_points: p.total_points | 0,
      points_per_game: num(p.points_per_game), form: num(p.form), ep_next: num(p.ep_next),
      selected_by: num(p.selected_by_percent), minutes: p.minutes | 0, starts: p.starts | 0,
      goals: p.goals_scored | 0, assists: p.assists | 0, clean_sheets: p.clean_sheets | 0,
      bonus: p.bonus | 0, xg: num(p.expected_goals), xa: num(p.expected_assists),
      xgc: num(p.expected_goals_conceded), transfers_in_event: p.transfers_in_event | 0,
      transfers_out_event: p.transfers_out_event | 0, status: p.status || "a",
      chance_of_playing: cop == null ? null : cop | 0, news: p.news || "",
      draft_rank: p.draft_rank ?? null,
      fixtures: upcoming, next_fixture: fixtureLabel(upcoming.filter(f => f.gw === gw.next_gw)),
    };
  });
  return { players, teams: Object.values(teams), gameweek: gw };
}

// --------------------------------------------------------------- model ----

export function availability(status, chance) {
  if (chance != null && Number.isFinite(chance)) return Math.max(0, Math.min(1, chance / 100));
  return { a: 1, d: 0.5 }[status] ?? 0;
}

export const fixtureMultiplier = f => (FDR_MULT[f.difficulty] ?? 1) + (f.home ? HOME_BONUS : 0);

function underlyingPerMatch(p, finishedGws) {
  if (p.minutes <= 0) return 0;
  const per90 = 90 / p.minutes;
  const xg90 = (p.xg || p.goals) * per90, xa90 = (p.xa || p.assists) * per90;
  const xgc90 = p.xgc ? p.xgc * per90 : 1.3;
  const pts90 = xg90 * (GOAL_PTS[p.position] ?? 5) + xa90 * ASSIST_PTS
    + Math.exp(-xgc90) * (CS_PTS[p.position] ?? 0) + p.bonus * per90 + 2;
  const gws = Math.max(finishedGws, 1);
  const minsShare = Math.min(1, p.minutes / (gws * 90));
  const startsShare = p.starts ? Math.min(1, p.starts / gws) : minsShare;
  return pts90 * Math.max(minsShare, startsShare * 0.9);
}

/** Add availability, base_xp, xp_next, xp_horizon, value, fdr_avg to each player. */
export function scorePlayers(players, finishedGws = 0, nextGw = null) {
  return players.map(p => {
    const avail = availability(p.status, p.chance_of_playing);
    const trust = Math.min(1, p.minutes / MIN_SAMPLE_MINUTES);
    const under = trust * underlyingPerMatch(p, finishedGws) + (1 - trust) * p.points_per_game;
    const ep = p.ep_next / (avail > 0 ? avail : 1);
    const base = WEIGHTS.underlying * under + WEIGHTS.form * p.form + WEIGHTS.ppg * p.points_per_game + WEIGHTS.ep * ep;
    const fx = Array.isArray(p.fixtures) ? p.fixtures : null;
    let xpNext, xpH, fdr;
    if (!fx) { xpNext = xpH = base * avail; fdr = 3; }
    else {
      const gw0 = nextGw ?? fx[0]?.gw;
      const later = avail > 0 ? Math.max(avail, 0.75) : 0.5;
      xpNext = sum(fx.filter(f => f.gw === gw0).map(f => base * fixtureMultiplier(f))) * avail;
      xpH = sum(fx.map(f => base * fixtureMultiplier(f) * (f.gw === gw0 ? avail : later)));
      fdr = fx.length ? sum(fx.map(f => f.difficulty)) / fx.length : 5;
    }
    return {
      ...p, availability: avail, base_xp: Math.round(base * 1000) / 1000,
      xp_next: r2(xpNext), xp_horizon: r2(xpH), fdr_avg: r2(fdr), n_fixtures: fx ? fx.length : 1,
      value: Math.round((r2(xpH) / (p.now_cost > 0 ? p.now_cost : 1)) * 1000) / 1000,
    };
  });
}

export function pickCaptain(scored, topN = 5) {
  let pool = scored.filter(p => p.availability >= 0.75);
  if (!pool.length) pool = scored;
  const ranked = [...pool].sort((a, b) => b.xp_next - a.xp_next || b.form - a.form);
  return {
    captain: ranked[0]?.name ?? null, vice_captain: ranked[1]?.name ?? null,
    score: ranked[0]?.xp_next ?? 0, options: ranked.slice(0, topN),
  };
}

// ----------------------------------------------------------- optimiser ----

export class OptimizationError extends Error {}

/** Exact best XI from a squad: enumerate the legal formations, take the top-k per position. */
export function bestXi(squad, metric = "xp_next") {
  if (squad.length < 11) throw new OptimizationError("A lineup needs at least 11 players");
  const byPos = {};
  for (const pos of POSITIONS) byPos[pos] = squad.filter(p => p.position === pos).sort((a, b) => b[metric] - a[metric]);
  let best = null;
  for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) for (let f = 1; f <= 3; f++) {
    if (d + m + f !== 10) continue;
    const want = { GKP: 1, DEF: d, MID: m, FWD: f };
    if (POSITIONS.some(pos => byPos[pos].length < want[pos])) continue;
    const starters = POSITIONS.flatMap(pos => byPos[pos].slice(0, want[pos]));
    const total = sum(starters.map(p => p[metric]));
    if (!best || total > best.total + 1e-9) best = { total, starters, formation: `${d}-${m}-${f}` };
  }
  if (!best) throw new OptimizationError("No legal formation in this squad");
  return packageLineup(squad, best.starters, best.formation, metric);
}

function packageLineup(squad, starters, formation, metric, budget = null) {
  const ids = new Set(starters.map(p => p.id));
  const order = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  const st = [...starters].sort((a, b) => order[a.position] - order[b.position] || b[metric] - a[metric]);
  const rest = squad.filter(p => !ids.has(p.id));
  const bench = [...rest.filter(p => p.position !== "GKP").sort((a, b) => b[metric] - a[metric]),
                 ...rest.filter(p => p.position === "GKP")];
  const byXp = [...st].sort((a, b) => b.xp_next - a.xp_next);
  const cost = r1(sum(squad.map(p => p.now_cost)));
  return {
    starters: st, bench, formation,
    captain: byXp[0]?.name ?? null, vice_captain: byXp[1]?.name ?? null,
    xp_next: r2(sum(st.map(p => p.xp_next)) + (byXp[0]?.xp_next ?? 0)),
    xp_horizon: r2(sum(st.map(p => p.xp_horizon))),
    total_cost: cost, bank: budget == null ? null : r1(budget - cost),
  };
}

/** Drop players who can never be in an optimal squad: for each, if at least
 *  (slots + 2) same-position players are both no dearer and no worse, he's dominated. */
function pruneDominated(pool, metric) {
  const keep = [];
  for (const pos of POSITIONS) {
    const group = pool.filter(p => p.position === pos).sort((a, b) => a.now_cost - b.now_cost || b[metric] - a[metric]);
    const limit = SQUAD_SLOTS[pos] + 2;       // +2 margin for the 3-per-club rule
    const bestSoFar = [];                     // top `limit` metrics among cheaper-or-equal players
    for (const p of group) {
      const dominated = bestSoFar.length >= limit && bestSoFar[limit - 1] >= p[metric];
      if (!dominated) keep.push(p);
      bestSoFar.push(p[metric]); bestSoFar.sort((a, b) => b - a); bestSoFar.length = Math.min(bestSoFar.length, limit);
    }
  }
  return keep;
}

/** Best 15 from scratch (wildcard / free hit) via integer programming. */
export function buildOptimalSquad(scored, { budget = 100, metric = "xp_horizon", minAvailability = 0.5,
                                            maxPerTeam = MAX_PER_TEAM, benchWeight = BENCH_WEIGHT } = {}) {
  const pool = pruneDominated(scored.filter(p => p.availability >= minAvailability && SQUAD_SLOTS[p.position]), metric);
  if (pool.length < 15) throw new OptimizationError("Need at least 15 eligible players");
  const model = { optimize: "obj", opType: "max", constraints: {}, variables: {}, ints: {}, options: { timeout: 20000 } };
  const C = model.constraints;
  C.squad = { equal: 15 }; C.xi = { equal: 11 }; C.cost = { max: budget };
  for (const pos of POSITIONS) {
    C[`sq_${pos}`] = { equal: SQUAD_SLOTS[pos] };
    C[`xi_${pos}`] = { min: XI_LIMITS[pos][0], max: XI_LIMITS[pos][1] };
  }
  for (const p of pool) {
    C[`team_${p.team_id}`] = { max: maxPerTeam };
    C[`link_${p.id}`] = { max: 0 };           // s_i - x_i <= 0
    C[`ub_x_${p.id}`] = { max: 1 }; C[`ub_s_${p.id}`] = { max: 1 };
    model.variables[`x_${p.id}`] = { obj: benchWeight * p[metric], squad: 1, cost: p.now_cost,
      [`sq_${p.position}`]: 1, [`team_${p.team_id}`]: 1, [`link_${p.id}`]: -1, [`ub_x_${p.id}`]: 1 };
    model.variables[`s_${p.id}`] = { obj: (1 - benchWeight) * p[metric], xi: 1,
      [`xi_${p.position}`]: 1, [`link_${p.id}`]: 1, [`ub_s_${p.id}`]: 1 };
    model.ints[`x_${p.id}`] = 1; model.ints[`s_${p.id}`] = 1;
  }
  const res = solver.Solve(model);
  if (!res.feasible) throw new OptimizationError("No feasible squad for this budget");
  const inSquad = pool.filter(p => Math.round(res[`x_${p.id}`] || 0) === 1);
  const starters = inSquad.filter(p => Math.round(res[`s_${p.id}`] || 0) === 1);
  const counts = Object.fromEntries(POSITIONS.map(pos => [pos, starters.filter(p => p.position === pos).length]));
  return packageLineup(inSquad, starters, `${counts.DEF}-${counts.MID}-${counts.FWD}`, metric, budget);
}

// ------------------------------------------------------------ analysis ----

/**
 * Rank transfers by gain in best-XI expected points over the horizon.
 * sellPrices: {id: price} from the authenticated my-team endpoint (falls back to now_cost).
 * freeTransfers >= 2 also evaluates pairs of moves.
 */
export function suggestTransfers(scored, squadIds, bank, { sellPrices = {}, freeTransfers = 1,
                                  metric = "xp_horizon", topN = 5, shortlist = 15 } = {}) {
  const byId = new Map(scored.map(p => [p.id, p]));
  const ids = new Set(squadIds);
  const squad = squadIds.map(id => byId.get(id)).filter(Boolean);
  if (squad.length < 11) return { singles: [], doubles: [] };
  const sell = p => sellPrices[p.id] ?? p.now_cost;
  const base = bestXi(squad, metric).xp_horizon;
  const clubs = {};
  for (const p of squad) clubs[p.team_id] = (clubs[p.team_id] || 0) + 1;
  const market = scored.filter(p => !ids.has(p.id) && p.availability >= 0.75);

  const cands = [];
  for (const out of squad) {
    const budget = sell(out) + bank + 1e-9;
    for (const inc of market) {
      if (inc.position !== out.position || inc.now_cost > budget) continue;
      if (inc.team_id !== out.team_id && (clubs[inc.team_id] || 0) >= MAX_PER_TEAM) continue;
      cands.push({ delta: inc[metric] - out[metric], out, inc });
    }
  }
  cands.sort((a, b) => b.delta - a.delta);

  const evalSquad = (outs, ins) => {
    const outIds = new Set(outs.map(p => p.id));
    return bestXi([...squad.filter(p => !outIds.has(p.id)), ...ins], metric).xp_horizon - base;
  };
  const move = (out, inc, gain) => ({ out, in: inc, gain: r2(gain), cost_change: r1(inc.now_cost - sell(out)), sell_price: sell(out) });

  const singles = [], seen = new Set();
  for (const c of cands) {
    const key = `${c.out.id}>${c.inc.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    singles.push(move(c.out, c.inc, evalSquad([c.out], [c.inc])));
    if (singles.length >= shortlist) break;
  }
  singles.sort((a, b) => b.gain - a.gain);
  // Show variety: keep only the best way to bring in each player
  const bestPerIn = [], usedIn = new Set();
  for (const s of singles) if (!usedIn.has(s.in.id)) { usedIn.add(s.in.id); bestPerIn.push(s); }

  const doubles = [];
  if (freeTransfers >= 2) {
    const top = cands.slice(0, 60);
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const a = top[i], b = top[j];
      if (a.out.id === b.out.id || a.inc.id === b.inc.id) continue;
      if (a.inc.now_cost + b.inc.now_cost > sell(a.out) + sell(b.out) + bank + 1e-9) continue;
      const c2 = { ...clubs };
      for (const o of [a.out, b.out]) c2[o.team_id]--;
      let ok = true;
      for (const n of [a.inc, b.inc]) if ((c2[n.team_id] = (c2[n.team_id] || 0) + 1) > MAX_PER_TEAM) ok = false;
      if (!ok) continue;
      doubles.push({ moves: [move(a.out, a.inc, 0), move(b.out, b.inc, 0)], gain: r2(evalSquad([a.out, b.out], [a.inc, b.inc])) });
    }
    doubles.sort((x, y) => y.gain - x.gain);
  }
  const uniqueDoubles = [], usedPairs = new Set();
  for (const d of doubles) {
    const key = d.moves.map(m => m.in.id).sort().join("+");
    if (!usedPairs.has(key)) { usedPairs.add(key); uniqueDoubles.push(d); }
  }
  return { singles: bestPerIn.slice(0, topN), doubles: uniqueDoubles.slice(0, 3) };
}

export function analyzeMyTeam(scored, manager) {
  const byId = new Map(scored.map(p => [p.id, p]));
  const squad = manager.picks.map(id => byId.get(id)).filter(Boolean);
  const lineup = bestXi(squad, "xp_next");
  const ft = manager.free_transfers ?? 1;
  const transfers = suggestTransfers(scored, manager.picks, manager.bank,
    { sellPrices: manager.sell_prices || {}, freeTransfers: ft });
  const bestSingle = transfers.singles[0], bestDouble = transfers.doubles[0];
  let advice;
  if (bestDouble && ft >= 2 && bestDouble.gain > (bestSingle?.gain ?? 0) + ROLL_THRESHOLD) {
    advice = `Use two transfers: ${bestDouble.moves.map(m => `${m.out.name} → ${m.in.name}`).join(" and ")} (+${bestDouble.gain.toFixed(1)} pts over the horizon).`;
  } else if (!bestSingle || bestSingle.gain < ROLL_THRESHOLD) {
    advice = `Save your free transfer — no move gains more than ${ROLL_THRESHOLD} pts over the horizon.`;
  } else {
    advice = `Best move: ${bestSingle.out.name} → ${bestSingle.in.name} (+${bestSingle.gain.toFixed(1)} pts over the horizon).`;
  }
  const { picks, sell_prices, current, ...rest } = manager;
  return { ...rest, lineup, lineup_diff: compareLineup(scored, current, lineup), current_lineup: current || null,
           sell_prices: sell_prices || {}, transfers: transfers.singles, double_transfers: transfers.doubles,
           flagged: squad.filter(p => p.availability < 1), advice,
           missing_players: manager.picks.filter(id => !byId.has(id)) };
}

export function marketInsights(scored, { topN = 8, differentialMaxOwned = 10 } = {}) {
  const avail = scored.filter(p => p.availability >= 0.75);
  const desc = k => (a, b) => b[k] - a[k];
  const value = {};
  for (const pos of POSITIONS) value[pos] = avail.filter(p => p.position === pos && p.minutes > 0).sort(desc("value")).slice(0, 5);
  const teams = new Map();
  for (const p of scored) if (!teams.has(p.team_id)) teams.set(p.team_id, p);
  const ticker = [...teams.values()].map(p => ({
    team: p.team, team_short: p.team_short, fixtures: p.fixtures || [], n_fixtures: (p.fixtures || []).length,
    fdr_avg: p.fixtures?.length ? r2(sum(p.fixtures.map(f => f.difficulty)) / p.fixtures.length) : null,
  })).sort((a, b) => (a.fdr_avg ?? 9) - (b.fdr_avg ?? 9) || b.n_fixtures - a.n_fixtures);
  return {
    differentials: avail.filter(p => p.selected_by < differentialMaxOwned).sort(desc("xp_horizon")).slice(0, topN),
    value_picks: value, fixture_ticker: ticker,
    most_transferred_in: [...scored].sort(desc("transfers_in_event")).slice(0, topN),
    most_transferred_out: [...scored].sort(desc("transfers_out_event")).slice(0, topN),
    injury_watch: scored.filter(p => p.availability < 1 && p.selected_by >= 5).sort(desc("selected_by")).slice(0, 15),
  };
}

/** Full report from raw API payloads (same shape as the Python dashboard payload). */
export function buildReport(bootstrap, fixtures, { manager = null, horizon = 5, budget = 100 } = {}) {
  const data = buildPlayers(bootstrap, fixtures, horizon);
  const gw = data.gameweek;
  const scored = scorePlayers(data.players, gw.finished_gws, gw.next_gw);
  let optimal = null, optimalError = null;
  try { optimal = buildOptimalSquad(scored, { budget }); } catch (e) { optimalError = e.message; }
  return {
    updated: new Date().toISOString(), gameweek: gw, horizon, budget,
    total_players: scored.length, captain: pickCaptain(scored),
    optimal_squad: optimal, optimal_error: optimalError,
    insights: marketInsights(scored),
    players: [...scored].sort((a, b) => b.xp_next - a.xp_next),
    my_team: manager ? analyzeMyTeam(scored, manager) : null,
  };
}

// ------------------------------------------------ lineup changes & saving ----

/** How your saved lineup compares with the best one.
 *  current = {starters: [ids], bench: [ids], captain: id, vice_captain: id} */
export function compareLineup(scored, current, best) {
  if (!current?.starters?.length) return null;
  const byId = new Map(scored.map(p => [p.id, p]));
  const xp = id => byId.get(id)?.xp_next ?? 0;
  const currentXp = r2(sum(current.starters.map(xp)) + (current.captain ? xp(current.captain) : 0));
  const bestIds = new Set(best.starters.map(p => p.id));
  const nowIds = new Set(current.starters);
  const bestCap = best.starters.find(p => p.name === best.captain);
  const bestVice = best.starters.find(p => p.name === best.vice_captain);
  const changes = [];
  const into = best.starters.filter(p => !nowIds.has(p.id));
  const outOf = current.starters.filter(id => !bestIds.has(id)).map(id => byId.get(id)).filter(Boolean);
  outOf.forEach((p, i) => changes.push(`Bench ${p.name}${into[i] ? `, start ${into[i].name}` : ""}`));
  if (bestCap && bestCap.id !== current.captain) changes.push(`Captain ${bestCap.name} (was ${byId.get(current.captain)?.name ?? "–"})`);
  if (bestVice && bestVice.id !== current.vice_captain) changes.push(`Vice-captain ${bestVice.name}`);
  return { current_xp: currentXp, best_xp: best.xp_next, gain: r2(best.xp_next - currentXp), changes };
}

/** Classic FPL lineup save body: GK first, then DEF/MID/FWD; bench GK is position 12. */
export function lineupPayload(lineup, withCaptain = true) {
  const benchGk = lineup.bench.filter(p => p.position === "GKP");
  const benchOut = lineup.bench.filter(p => p.position !== "GKP");
  const ordered = [...lineup.starters, ...benchGk, ...benchOut];
  const picks = ordered.map((p, i) => {
    const pick = { element: p.id, position: i + 1 };
    if (withCaptain) Object.assign(pick, { is_captain: p.name === lineup.captain, is_vice_captain: p.name === lineup.vice_captain });
    return pick;
  });
  return withCaptain ? { chip: null, picks } : { picks, subs: [] };
}

/** Classic FPL transfer body. Prices in tenths; selling price must be your real one. */
export function transferPayload({ entry, event, moves, sellPrices = {} }) {
  return {
    confirmed: true, entry, event, chip: null,
    transfers: moves.map(m => ({
      element_in: m.in.id, element_out: m.out.id,
      purchase_price: Math.round(m.in.now_cost * 10),
      selling_price: Math.round((sellPrices[m.out.id] ?? m.sell_price ?? m.out.now_cost) * 10),
    })),
  };
}

/** Bank, free transfers used and points hit for a set of moves. */
export function transferCost(moves, { bank, freeTransfers = 1, unlimited = false, sellPrices = {} }) {
  const spend = sum(moves.map(m => m.in.now_cost - (sellPrices[m.out.id] ?? m.sell_price ?? m.out.now_cost)));
  const extra = unlimited ? 0 : Math.max(0, moves.length - freeTransfers);
  return { bank_after: r1(bank - spend), hit: extra * 4, affordable: bank - spend >= -1e-9 };
}

// ------------------------------------------------------------- draft ----

/** Turn the Draft API's bootstrap into the classic shape so the same model runs on it.
 *  Fixtures come from the classic API; clubs are matched by short name. */
export function normalizeDraftBootstrap(draft, classicFixtures = [], classicTeams = []) {
  const events = Array.isArray(draft.events) ? draft.events : (draft.events?.data || []).map(e => ({
    ...e, is_next: e.id === draft.events.next, is_current: e.id === draft.events.current,
  }));
  const shortToDraft = Object.fromEntries(draft.teams.map(t => [t.short_name, t.id]));
  const classicToShort = Object.fromEntries(classicTeams.map(t => [t.id, t.short_name]));
  const mapTeam = id => classicTeams.length ? shortToDraft[classicToShort[id]] : id;
  const fixtures = (classicFixtures || []).map(f => ({ ...f, team_h: mapTeam(f.team_h), team_a: mapTeam(f.team_a) }))
    .filter(f => f.team_h && f.team_a);
  return { bootstrap: { ...draft, events, elements: draft.elements.map(e => ({ now_cost: 0, ...e })) }, fixtures };
}

/** Like-for-like swaps between your squad and unowned players, ranked by best-XI gain. */
export function suggestDraftMoves(scored, squadIds, available, { metric = "xp_horizon", topN = 8, shortlist = 25 } = {}) {
  const byId = new Map(scored.map(p => [p.id, p]));
  const squad = squadIds.map(id => byId.get(id)).filter(Boolean);
  if (squad.length < 11) return [];
  const base = bestXi(squad, metric).xp_horizon;
  const pool = scored.filter(p => available[p.id] && p.availability >= 0.75);
  const cands = [];
  for (const out of squad) for (const inc of pool)
    if (inc.position === out.position) cands.push({ delta: inc[metric] - out[metric], out, inc });
  cands.sort((a, b) => b.delta - a.delta);
  const moves = [];
  for (const c of cands.slice(0, shortlist * 3)) {
    const gain = bestXi([...squad.filter(p => p.id !== c.out.id), c.inc], metric).xp_horizon - base;
    if (gain > 0) moves.push({ out: c.out, in: c.inc, gain: r2(gain), kind: available[c.inc.id] === "w" ? "waiver" : "free agent" });
  }
  moves.sort((a, b) => b.gain - a.gain);
  // one suggestion per incoming player, and at most 3 per player you'd drop
  const seen = new Set(), outs = {};
  return moves.filter(m => {
    if (seen.has(m.in.id) || (outs[m.out.id] || 0) >= 3) return false;
    seen.add(m.in.id); outs[m.out.id] = (outs[m.out.id] || 0) + 1; return true;
  }).slice(0, topN);
}

/** Draft-day big board: season value over replacement level for each position. */
export function draftBigBoard(scored, { leagueSize = 8, taken = new Set(), limit = 150 } = {}) {
  const season = p => p.base_xp * (0.5 + 0.5 * p.availability);
  const repl = {};
  for (const pos of POSITIONS) {
    const vals = scored.filter(p => p.position === pos).map(season).sort((a, b) => b - a);
    repl[pos] = vals[Math.min(vals.length - 1, leagueSize * SQUAD_SLOTS[pos])] ?? 0;
  }
  return scored.map(p => ({ ...p, season_xp: r2(season(p)), vorp: r2(season(p) - repl[p.position]), taken: taken.has(p.id) }))
    .sort((a, b) => b.vorp - a.vorp).slice(0, limit)
    .map((p, i) => ({ ...p, board_rank: i + 1 }));
}

/** Best next draft pick given the positions you still need. */
export function nextDraftPick(board, mySquadIds = []) {
  const mine = new Set(mySquadIds);
  const have = {};
  for (const p of board) if (mine.has(p.id)) have[p.position] = (have[p.position] || 0) + 1;
  return board.find(p => !p.taken && !mine.has(p.id) && (have[p.position] || 0) < SQUAD_SLOTS[p.position]) || null;
}

/** Full Draft report. ctx: {entry, league, picks, elementStatus, choices, current} */
export function buildDraftReport(draftBootstrap, classicFixtures, classicTeams, ctx, { horizon = 5 } = {}) {
  const { bootstrap, fixtures } = normalizeDraftBootstrap(draftBootstrap, classicFixtures, classicTeams);
  const data = buildPlayers(bootstrap, fixtures, horizon);
  const gw = data.gameweek;
  const scored = scorePlayers(data.players, gw.finished_gws, gw.next_gw);
  const status = ctx.elementStatus || [];
  const available = {}, taken = new Set();
  for (const s of status) {
    if (s.owner == null && s.status !== "o") available[s.element] = s.status === "w" ? "w" : "a";
    else taken.add(s.element);
  }
  for (const c of ctx.choices || []) if (c.element) taken.add(c.element);
  const leagueSize = ctx.league?.league_entries?.length || 8;
  const board = draftBigBoard(scored, { leagueSize, taken });
  const byId = new Map(scored.map(p => [p.id, p]));
  const squadIds = ctx.picks || [];
  let lineup = null, lineupDiff = null, moves = [];
  if (squadIds.length >= 11) {
    lineup = bestXi(squadIds.map(id => byId.get(id)).filter(Boolean), "xp_next");
    lineup.captain = lineup.vice_captain = null;             // no captains in Draft
    lineup.xp_next = r2(sum(lineup.starters.map(p => p.xp_next)));
    if (ctx.current?.starters?.length) {
      const cur = r2(sum(ctx.current.starters.map(id => byId.get(id)?.xp_next ?? 0)));
      const bestIds = new Set(lineup.starters.map(p => p.id)), nowIds = new Set(ctx.current.starters);
      const outOf = ctx.current.starters.filter(id => !bestIds.has(id)).map(id => byId.get(id)).filter(Boolean);
      const into = lineup.starters.filter(p => !nowIds.has(p.id));
      lineupDiff = { current_xp: cur, best_xp: lineup.xp_next, gain: r2(lineup.xp_next - cur),
                     changes: outOf.map((p, i) => `Bench ${p.name}${into[i] ? `, start ${into[i].name}` : ""}`) };
    }
    moves = suggestDraftMoves(scored, squadIds, available);
  }
  const freeAgents = {};
  for (const pos of POSITIONS)
    freeAgents[pos] = scored.filter(p => available[p.id] && p.position === pos)
      .sort((a, b) => b.xp_horizon - a.xp_horizon).slice(0, 6).map(p => ({ ...p, claim: available[p.id] }));
  const draftStatus = ctx.league?.league?.draft_status || null;
  return {
    updated: new Date().toISOString(), gameweek: gw, horizon,
    entry: ctx.entry || null, league: ctx.league?.league ? { id: ctx.league.league.id, name: ctx.league.league.name,
      draft_status: draftStatus, size: leagueSize } : null,
    lineup, lineup_diff: lineupDiff, moves, free_agents: freeAgents,
    big_board: board, next_pick: draftStatus === "post" ? null : nextDraftPick(board, squadIds),
    squad: squadIds.map(id => byId.get(id)).filter(Boolean),
  };
}
