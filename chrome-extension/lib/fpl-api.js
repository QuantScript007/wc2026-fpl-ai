// FPL + FPL Draft API access for the extension, including saving changes to your team.
//
// Classic FPL authenticates with an `X-API-Authorization: Bearer <jwt>` header that its
// own web app sends. The background worker notices that header while you browse
// fantasy.premierleague.com and keeps it in session storage (memory only). Draft
// reads use public endpoints; Draft saves run inside a draft.premierleague.com tab
// so they carry your Draft login exactly like the site does.
import { buildDraftReport, buildReport, lineupPayload, transferPayload } from "./core.js";

export const FPL = "https://fantasy.premierleague.com";
export const DRAFT = "https://draft.premierleague.com";
const API = `${FPL}/api`;
const DRAFT_API = `${DRAFT}/api`;
const DEFAULT_SETTINGS = { teamId: "", horizon: 5, budget: 100, draftEntryId: "", draftLeagueId: "", autoLineup: false };

export class AuthError extends Error {}
export class ApplyError extends Error {
  constructor(message, { fallbackUrl = null } = {}) { super(message); this.fallbackUrl = fallbackUrl; }
}

// ------------------------------------------------------------ helpers ----

export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

async function validToken(key) {
  const got = await chrome.storage.session.get(key);
  const t = got[key];
  if (!t) return null;
  const exp = tokenExpiry(t);
  return exp && exp < Date.now() + 30_000 ? null : t;
}
export const getToken = () => validToken("fplToken");
export const getDraftToken = () => validToken("draftToken");
export const saveToken = token => chrome.storage.session.set({ fplToken: token, fplTokenAt: Date.now() });
export const saveDraftToken = token => chrome.storage.session.set({ draftToken: token });
export const clearToken = () => chrome.storage.session.remove(["fplToken", "fplTokenAt", "draftToken"]);

async function errorText(resp) {
  const body = await resp.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    const msgs = [];
    const walk = v => Array.isArray(v) ? v.forEach(walk) : v && typeof v === "object" ? Object.values(v).forEach(walk) : v != null && msgs.push(String(v));
    walk(j);
    return msgs.join(" · ").slice(0, 300) || `HTTP ${resp.status}`;
  } catch { return body.slice(0, 200) || `HTTP ${resp.status}`; }
}

async function getJSON(base, path, token = null) {
  const headers = { Accept: "application/json" };
  if (token) headers["X-API-Authorization"] = `Bearer ${token}`;
  const resp = await fetch(`${base}${path}`, { headers, credentials: "include" });
  if (resp.status === 401 || resp.status === 403) throw new AuthError(`FPL refused ${path} (${resp.status})`);
  if (!resp.ok) throw new Error(`${path} failed (${resp.status})`);
  return resp.json();
}
const classicGet = (path, token) => getJSON(API, path, token);
const draftGet = (path, token) => getJSON(DRAFT_API, path, token);

async function classicPost(path, body) {
  const token = await getToken();
  if (!token) throw new ApplyError("Not logged in to FPL — open fantasy.premierleague.com, log in, then try again.",
                                    { fallbackUrl: `${FPL}/my-team` });
  const resp = await fetch(`${API}${path}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) {
    await clearToken();
    throw new ApplyError("Your FPL login expired — open FPL, then try again.", { fallbackUrl: `${FPL}/my-team` });
  }
  if (!resp.ok) throw new ApplyError(`FPL rejected the change: ${await errorText(resp)}`);
  return resp.status === 204 ? {} : resp.json().catch(() => ({}));
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ------------------------------------------------------- classic reads ----

function lineupFromPicks(picks) {
  const sorted = [...picks].sort((a, b) => a.position - b.position);
  return {
    starters: sorted.filter(p => p.position <= 11).map(p => p.element),
    bench: sorted.filter(p => p.position > 11).map(p => p.element),
    captain: picks.find(p => p.is_captain)?.element ?? null,
    vice_captain: picks.find(p => p.is_vice_captain)?.element ?? null,
  };
}

async function fetchMyTeamAuthed(token) {
  const me = await classicGet("/me/", token);
  const entryId = me?.player?.entry;
  if (!entryId) throw new AuthError("Logged in, but no FPL team found on this account");
  const [entry, myTeam] = await Promise.all([classicGet(`/entry/${entryId}/`), classicGet(`/my-team/${entryId}/`, token)]);
  const t = myTeam.transfers || {};
  const sellPrices = {};
  for (const p of myTeam.picks || []) if (p.selling_price != null) sellPrices[p.element] = p.selling_price / 10;
  const unlimited = t.status === "unlimited";
  const freeTransfers = t.limit == null ? (unlimited ? 15 : 1) : Math.max(0, t.limit - (t.made || 0));
  return {
    source: "account", entry_id: entryId,
    manager: `${entry.player_first_name || me.player.first_name || ""} ${entry.player_last_name || me.player.last_name || ""}`.trim(),
    team_name: entry.name || "", gameweek: entry.current_event,
    overall_rank: entry.summary_overall_rank, overall_points: entry.summary_overall_points,
    bank: (t.bank ?? 0) / 10, team_value: (t.value ?? entry.last_deadline_value ?? 0) / 10,
    free_transfers: freeTransfers, transfer_status: t.status || null, unlimited_transfers: unlimited,
    chips: (myTeam.chips || []).map(c => ({ name: c.name, status: c.status_for_entry })),
    picks: (myTeam.picks || []).map(p => p.element), sell_prices: sellPrices,
    current: lineupFromPicks(myTeam.picks || []),
  };
}

async function fetchTeamPublic(entryId) {
  const entry = await classicGet(`/entry/${entryId}/`);
  const gw = entry.current_event;
  if (!gw) throw new Error(`Team ${entryId} has no picks yet this season`);
  const picks = await classicGet(`/entry/${entryId}/event/${gw}/picks/`);
  const h = picks.entry_history || {};
  return {
    source: "public", entry_id: Number(entryId),
    manager: `${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim(),
    team_name: entry.name || "", gameweek: gw,
    overall_rank: entry.summary_overall_rank, overall_points: entry.summary_overall_points,
    bank: (h.bank ?? entry.last_deadline_bank ?? 0) / 10, team_value: (h.value ?? entry.last_deadline_value ?? 0) / 10,
    free_transfers: 1, chips: [], picks: (picks.picks || []).map(p => p.element), sell_prices: {},
  };
}

// --------------------------------------------------------- draft reads ----

async function fetchDraft(settings, classicFixtures, classicTeams, horizon) {
  const entryId = settings.draftEntryId;
  const token = await getDraftToken();
  const [bootstrap, game, entryPub] = await Promise.all([
    draftGet("/bootstrap-static"), draftGet("/game").catch(() => ({})), draftGet(`/entry/${entryId}/public`)]);
  const entry = entryPub.entry || entryPub;
  const leagueId = settings.draftLeagueId || entry.league_set?.[0];
  if (!leagueId) throw new Error("This Draft team isn't in a league yet");
  const [league, status] = await Promise.all([
    draftGet(`/league/${leagueId}/details`), draftGet(`/league/${leagueId}/element-status`).catch(() => ({ element_status: [] }))]);
  const draftStatus = league.league?.draft_status;

  let picks = [], current = null, choices = [];
  const gw = game.current_event || null;
  // Pending lineup (only visible to you) first, then the last published one
  try {
    const mine = await draftGet(`/entry/${entryId}/my-team`, token);
    if (mine?.picks?.length) { picks = mine.picks.map(p => p.element); current = lineupFromPicks(mine.picks); }
  } catch { /* not logged in to Draft in this browser */ }
  if (!picks.length && gw) {
    try {
      const ev = await draftGet(`/entry/${entryId}/event/${gw}`);
      picks = (ev.picks || []).map(p => p.element);
      current = lineupFromPicks(ev.picks || []);
    } catch { /* no picks yet */ }
  }
  if (draftStatus !== "post") {
    try {
      choices = (await draftGet(`/draft/${leagueId}/choices`)).choices || [];
      if (!picks.length) picks = choices.filter(c => c.element && c.entry === Number(entryId)).map(c => c.element);
    } catch { /* draft room not open */ }
  }
  const report = buildDraftReport(bootstrap, classicFixtures, classicTeams,
    { entry, league, picks, elementStatus: status.element_status || [], choices, current }, { horizon });
  report.entry = { id: Number(entryId), name: entry.name, manager: `${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim() };
  report.league_id = Number(leagueId);
  report.draft_gw = game.next_event || gw;
  report.waivers_processed = game.waivers_processed ?? null;
  return report;
}

// ------------------------------------------------------------ refresh ----

export async function refreshReport() {
  const settings = await getSettings();
  const [bootstrap, fixtures] = await Promise.all([classicGet("/bootstrap-static/"), classicGet("/fixtures/?future=1").catch(() => [])]);

  let manager = null, connection = { status: "disconnected", error: null };
  const token = await getToken();
  if (token) {
    try {
      manager = await fetchMyTeamAuthed(token);
      connection = { status: "connected", error: null };
    } catch (e) {
      if (e instanceof AuthError) await clearToken();
      connection = { status: "expired", error: e.message };
    }
  }
  if (!manager && settings.teamId) {
    try { manager = await fetchTeamPublic(settings.teamId); }
    catch (e) { connection.error = `Team ${settings.teamId}: ${e.message}`; }
  }

  const report = buildReport(bootstrap, fixtures, { manager, horizon: settings.horizon, budget: settings.budget });
  report.connection = connection;
  report.draft = null; report.draft_error = null;
  if (settings.draftEntryId) {
    try { report.draft = await fetchDraft(settings, fixtures, bootstrap.teams, settings.horizon); }
    catch (e) { report.draft_error = e.message; }
  }
  const { autopilotLog } = await chrome.storage.local.get("autopilotLog");
  report.autopilot = autopilotLog || null;
  await chrome.storage.local.set({ report, reportError: null });
  return report;
}

export async function getCachedReport() {
  const { report, reportError } = await chrome.storage.local.get(["report", "reportError"]);
  return { report: report || null, error: reportError || null };
}

// -------------------------------------------------------- saving (classic) ----

function assertBeforeDeadline(report) {
  const dl = report?.gameweek?.next_deadline;
  if (dl && new Date(dl) <= new Date()) throw new ApplyError("The gameweek deadline has passed — changes are locked until it finishes.");
}

/** Save the best XI, bench order, captain and vice-captain, then check FPL stored it. */
export async function applyClassicLineup(report) {
  const m = report?.my_team;
  if (!m || m.source !== "account") throw new ApplyError("Log in to FPL first so the extension can edit your team.", { fallbackUrl: `${FPL}/my-team` });
  assertBeforeDeadline(report);
  const body = lineupPayload(m.lineup);
  await classicPost(`/my-team/${m.entry_id}/`, body);
  const saved = lineupFromPicks((await classicGet(`/my-team/${m.entry_id}/`, await getToken())).picks || []);
  const want = lineupFromPicks(body.picks);
  const ok = saved.captain === want.captain && want.starters.every(id => saved.starters.includes(id));
  if (!ok) throw new ApplyError("FPL accepted the request but the saved team looks different — check it on the FPL site.",
                                { fallbackUrl: `${FPL}/my-team` });
  return { message: `Lineup saved: ${m.lineup.formation}, captain ${m.lineup.captain}, vice ${m.lineup.vice_captain}.` };
}

/** Make transfers (ids from the report), then re-optimise and save the new lineup. */
export async function applyClassicTransfers(report, moves, { thenLineup = true } = {}) {
  const m = report?.my_team;
  if (!m || m.source !== "account") throw new ApplyError("Log in to FPL first so the extension can make transfers.", { fallbackUrl: `${FPL}/transfers` });
  assertBeforeDeadline(report);
  const byId = new Map(report.players.map(p => [p.id, p]));
  const full = moves.map(x => ({ out: byId.get(x.out), in: byId.get(x.in), sell_price: m.sell_prices?.[x.out] }));
  if (full.some(x => !x.out || !x.in)) throw new ApplyError("Player data is out of date — refresh and try again.");
  const payload = transferPayload({ entry: m.entry_id, event: report.gameweek.next_gw, moves: full, sellPrices: m.sell_prices || {} });
  await classicPost("/transfers/", payload);
  const names = full.map(x => `${x.out.name} → ${x.in.name}`).join(", ");
  let extra = "";
  if (thenLineup) {
    const fresh = await refreshReport();
    try { extra = " " + (await applyClassicLineup(fresh)).message; }
    catch (e) { extra = ` (Transfers done, but the lineup wasn't updated: ${e.message})`; }
  }
  return { message: `Transfers made: ${names}.${extra}` };
}

// ---------------------------------------------------------- saving (draft) ----

async function draftTab() {
  const tabs = await chrome.tabs.query({ url: `${DRAFT}/*` });
  if (tabs.length) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: `${DRAFT}/team/my`, active: false });
  await new Promise(resolve => {
    const done = (id, info) => { if (id === tab.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(resolve, 15000);
  });
  return tab.id;
}

/** POST from inside a Draft tab so the request carries the site's own login. */
async function draftPost(path, body) {
  const tabId = await draftTab();
  const token = await getDraftToken();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [`${DRAFT_API}${path}`, body, token],
    func: async (url, payload, bearer) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      const csrf = document.cookie.split("; ").find(c => c.startsWith("csrftoken="));
      if (csrf) headers["X-CSRFToken"] = csrf.split("=")[1];
      if (bearer) headers["X-API-Authorization"] = `Bearer ${bearer}`;
      const r = await fetch(url, { method: "POST", credentials: "include", headers, body: JSON.stringify(payload) });
      return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 400) };
    },
  });
  if (!result?.ok) {
    let reason = result?.text || `HTTP ${result?.status}`;
    try { reason = Object.values(JSON.parse(reason)).flat().join(" · ") || reason; } catch { /* keep text */ }
    throw new ApplyError(`FPL Draft didn't accept the automatic change (${result?.status}: ${reason.slice(0, 160)}).`);
  }
  return result;
}

export async function applyDraftLineup(report) {
  const d = report?.draft;
  if (!d?.lineup) throw new ApplyError("No Draft squad found — set your Draft team ID in Settings.");
  try {
    await draftPost(`/entry/${d.entry.id}/my-team`, lineupPayload(d.lineup, false));
  } catch (e) {
    throw new ApplyError(`${e.message} Opened your Draft team page — the best XI is listed in the Draft tab.`, { fallbackUrl: `${DRAFT}/team/my` });
  }
  return { message: `Draft lineup saved: ${d.lineup.formation}.` };
}

export async function applyDraftClaim(report, move) {
  const d = report?.draft;
  if (!d) throw new ApplyError("No Draft league loaded.");
  const body = { entry: d.entry.id, event: d.draft_gw, element_in: move.in, element_out: move.out, kind: move.kind === "waiver" ? "w" : "f" };
  try {
    await draftPost("/draft/transaction", body);
  } catch (e) {
    throw new ApplyError(`${e.message} Opened the Draft transactions page so you can make it there.`, { fallbackUrl: `${DRAFT}/team/transactions` });
  }
  return { message: move.kind === "waiver" ? "Waiver claim submitted." : "Free-agent signing done." };
}
