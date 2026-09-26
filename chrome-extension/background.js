// Background service worker: captures the FPL login token, refreshes data
// on a schedule, and shows the time to the next deadline on the toolbar icon.
import { FPL, clearToken, getCachedReport, refreshReport, saveToken, tokenExpiry } from "./lib/fpl-api.js";

const REFRESH_MINUTES = 180;
let refreshing = null;

// 1) Pick up the auth header FPL's own site sends while you're logged in.
chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (details.initiator?.startsWith("chrome-extension://")) return;   // ignore our own calls
    const h = details.requestHeaders?.find(x => x.name.toLowerCase() === "x-api-authorization");
    const token = h?.value?.replace(/^Bearer\s+/i, "");
    if (!token || !tokenExpiry(token)) return;
    chrome.storage.session.get("fplToken").then(({ fplToken }) => {
      if (fplToken !== token) saveToken(token).then(() => refresh().catch(() => {}));
    });
  },
  { urls: [`${FPL}/api/*`] },
  ["requestHeaders"]
);

// 2) Refresh (deduplicated so popup + dashboard + alarm don't stack up).
function refresh() {
  if (!refreshing) {
    refreshing = refreshReport()
      .then(async r => { await updateBadge(r); return r; })
      .catch(async e => { await chrome.storage.local.set({ reportError: e.message }); throw e; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "refresh") {
    refresh().then(r => reply({ ok: true, updated: r.updated })).catch(e => reply({ ok: false, error: e.message }));
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
