// FPL API access for the extension: public endpoints + your logged-in session.
//
// FPL authenticates account endpoints with an `X-API-Authorization: Bearer <jwt>`
// header that its own web app sends. The background worker notices that header
// while you browse fantasy.premierleague.com and keeps it in session storage
// (memory only, cleared when Chrome closes). It never leaves your browser.
import { buildReport } from "./core.js";

export const FPL = "https://fantasy.premierleague.com";
const API = `${FPL}/api`;
const DEFAULT_SETTINGS = { teamId: "", horizon: 5, budget: 100 };

export class AuthError extends Error {}

export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

export async function getToken() {
  const { fplToken } = await chrome.storage.session.get("fplToken");
  if (!fplToken) return null;
  const exp = tokenExpiry(fplToken);
  return exp && exp < Date.now() + 30_000 ? null : fplToken;
}

export async function saveToken(token) {
  await chrome.storage.session.set({ fplToken: token, fplTokenAt: Date.now() });
}

export async function clearToken() {
  await chrome.storage.session.remove(["fplToken", "fplTokenAt"]);
}

async function getJSON(path, token = null) {
  const headers = { Accept: "application/json" };
  if (token) headers["X-API-Authorization"] = `Bearer ${token}`;
  const resp = await fetch(`${API}${path}`, { headers, credentials: "include" });
  if (resp.status === 401 || resp.status === 403) throw new AuthError(`FPL refused ${path} (${resp.status})`);
  if (!resp.ok) throw new Error(`FPL ${path} failed (${resp.status})`);
  return resp.json();
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

/** Logged-in manager: real picks, selling prices, bank, free transfers and chips. */
async function fetchMyTeamAuthed(token) {
  const me = await getJSON("/me/", token);
  const entryId = me?.player?.entry;
  if (!entryId) throw new AuthError("Logged in, but no FPL team found on this account");
  const [entry, myTeam] = await Promise.all([getJSON(`/entry/${entryId}/`), getJSON(`/my-team/${entryId}/`, token)]);
  const t = myTeam.transfers || {};
  const sellPrices = {};
  for (const p of myTeam.picks || []) if (p.selling_price != null) sellPrices[p.element] = p.selling_price / 10;
  const freeTransfers = t.limit == null ? (t.status === "unlimited" ? 15 : 1) : Math.max(0, t.limit - (t.made || 0));
  return {
    source: "account", entry_id: entryId,
    manager: `${entry.player_first_name || me.player.first_name || ""} ${entry.player_last_name || me.player.last_name || ""}`.trim(),
    team_name: entry.name || "", gameweek: entry.current_event,
    overall_rank: entry.summary_overall_rank, overall_points: entry.summary_overall_points,
    bank: (t.bank ?? 0) / 10, team_value: (t.value ?? entry.last_deadline_value ?? 0) / 10,
    free_transfers: freeTransfers, transfer_status: t.status || null,
    chips: (myTeam.chips || []).map(c => ({ name: c.name, status: c.status_for_entry })),
    picks: (myTeam.picks || []).map(p => p.element), sell_prices: sellPrices,
  };
}

/** Anyone's team by ID from public endpoints (latest published picks, current prices). */
async function fetchTeamPublic(entryId) {
  const entry = await getJSON(`/entry/${entryId}/`);
  const gw = entry.current_event;
  if (!gw) throw new Error(`Team ${entryId} has no picks yet this season`);
  const picks = await getJSON(`/entry/${entryId}/event/${gw}/picks/`);
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

/** Fetch everything, analyse, and cache the report in chrome.storage.local. */
export async function refreshReport() {
  const settings = await getSettings();
  const [bootstrap, fixtures] = await Promise.all([getJSON("/bootstrap-static/"), getJSON("/fixtures/?future=1").catch(() => [])]);

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
  await chrome.storage.local.set({ report, reportError: null });
  return report;
}

export async function getCachedReport() {
  const { report, reportError } = await chrome.storage.local.get(["report", "reportError"]);
  return { report: report || null, error: reportError || null };
}
