// Background service worker: captures FPL / FPL Draft logins, refreshes data on a
// schedule, applies changes you choose, and shows the deadline on the toolbar icon.
import {
  DRAFT, FPL, applyClassicLineup, applyClassicTransfers, applyDraftClaim, applyDraftLineup,
  clearToken, getCachedReport, getSettings, refreshReport, saveDraftToken, saveSettings, saveToken, tokenExpiry,
} from "./lib/fpl-api.js";

const REFRESH_MINUTES = 180;
const AUTOPILOT_MIN_GAIN = 0.5;
let refreshing = null;
let applying = false;

const bearer = details => {
  const h = details.requestHeaders?.find(x => x.name.toLowerCase() === "x-api-authorization");
  const t = h?.value?.replace(/^Bearer\s+/i, "");
  return t && tokenExpiry(t) ? t : null;
};
const fromUs = details => details.initiator?.startsWith("chrome-extension://");

// 1) Classic FPL: pick up the auth header the site sends while you're logged in.
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (fromUs(details)) return;
  const token = bearer(details);
  if (!token) return;
  chrome.storage.session.get("fplToken").then(({ fplToken }) => {
    if (fplToken !== token) saveToken(token).then(() => refresh().catch(() => {}));
  });
}, { urls: [`${FPL}/api/*`] }, ["requestHeaders"]);

// 2) Draft: remember your entry ID (and any auth header) when the Draft site loads your team.
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (fromUs(details)) return;
  const token = bearer(details);
  if (token) saveDraftToken(token);
  const m = details.url.match(/\/api\/entry\/(\d+)\/my-team/);
  if (!m) return;
  getSettings().then(s => {
    if (s.draftEntryId !== m[1]) saveSettings({ draftEntryId: m[1], draftLeagueId: "" }).then(() => refresh().catch(() => {}));
  });
}, { urls: [`${DRAFT}/api/*`] }, ["requestHeaders"]);

// 3) Refresh (deduplicated), with the optional lineup autopilot. A request that
//    arrives mid-refresh (e.g. you just logged in) queues exactly one more run.
let rerun = false;
function refresh() {
  if (refreshing) { rerun = true; return refreshing; }
  refreshing = refreshReport()
    .then(autopilot)
    .then(async r => { await updateBadge(r); return r; })
    .catch(async e => { await chrome.storage.local.set({ reportError: e.message }); throw e; })
    .finally(() => {
      refreshing = null;
      if (rerun) { rerun = false; refresh().catch(() => {}); }
    });
  return refreshing;
}

async function autopilot(report) {
  const s = await getSettings();
  const m = report.my_team, diff = m?.lineup_diff;
  const dl = report.gameweek?.next_deadline ? new Date(report.gameweek.next_deadline) : null;
  if (!s.autoLineup || applying || m?.source !== "account" || !diff || diff.gain < AUTOPILOT_MIN_GAIN || !dl || dl <= new Date()) return report;
  applying = true;
  let log;
  try {
    const res = await applyClassicLineup(report);
    log = { at: new Date().toISOString(), ok: true, message: res.message, gain: diff.gain, changes: diff.changes };
  } catch (e) {
    log = { at: new Date().toISOString(), ok: false, message: e.message };
  } finally { applying = false; }
  await chrome.storage.local.set({ autopilotLog: log });
  return log.ok ? refreshReport() : { ...report, autopilot: log };
}

async function updateBadge(report) {
  const dl = report?.gameweek?.next_deadline ? new Date(report.gameweek.next_deadline).getTime() : null;
  const hours = dl ? (dl - Date.now()) / 3.6e6 : null;
  let text = "";
  if (hours != null && hours > 0 && hours < 48) text = hours < 1 ? `${Math.ceil(hours * 60)}m` : `${Math.floor(hours)}h`;
  const flagged = report?.my_team?.lineup?.starters?.some(p => p.availability < 1);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: flagged ? "#d97706" : "#37003c" });
  await chrome.action.setTitle({ title: text ? `FPL AI — deadline in ${text}${flagged ? " · check injuries" : ""}` : "FPL AI Analyzer" });
}

// 4) Apply a change the user confirmed in the popup or dashboard.
async function apply(msg) {
  if (applying) throw new Error("Another change is being saved — wait a moment.");
  applying = true;
  try {
    const { report } = await getCachedReport();
    if (!report) throw new Error("No data yet — press Refresh first.");
    let res;
    if (msg.action === "lineup") res = await applyClassicLineup(report);
    else if (msg.action === "transfers") res = await applyClassicTransfers(report, msg.moves, { thenLineup: msg.thenLineup !== false });
    else if (msg.action === "draft-lineup") res = await applyDraftLineup(report);
    else if (msg.action === "draft-claim") res = await applyDraftClaim(report, msg.move);
    else throw new Error(`Unknown action ${msg.action}`);
    return res;
  } finally { applying = false; }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "refresh") {
    refresh().then(r => reply({ ok: true, updated: r.updated })).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "apply") {
    apply(msg)
      .then(async res => { await refresh().catch(() => {}); reply({ ok: true, message: res.message }); })
      .catch(e => {
        if (e.fallbackUrl) chrome.tabs.create({ url: e.fallbackUrl });
        reply({ ok: false, error: e.message });
      });
    return true;
  }
  if (msg?.type === "disconnect") {
    clearToken().then(() => refresh()).then(() => reply({ ok: true })).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES });
  chrome.alarms.create("badge", { periodInMinutes: 15 });
  refresh().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => refresh().catch(() => {}));
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "refresh") refresh().catch(() => {});
  if (a.name === "badge") getCachedReport().then(({ report }) => updateBadge(report));
});
