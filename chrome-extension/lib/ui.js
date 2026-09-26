// Small DOM/format helpers shared by the popup and dashboard.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const num = (v, d = 1) => v == null || isNaN(v) ? "–" : Number(v).toFixed(d);
export const money = v => v == null ? "–" : "£" + Number(v).toFixed(1) + "m";

export function deadlineText(iso) {
  if (!iso) return "–";
  const d = new Date(iso), ms = d - Date.now();
  const when = d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (ms <= 0) return when;
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  return `${when} (${h >= 48 ? Math.floor(h / 24) + "d" : h + "h " + m + "m"})`;
}

export function availPill(p) {
  const a = p.availability ?? 1;
  if (a >= 1) return "";
  return ` <span class="pill ${a === 0 ? "bad" : "warn"}" title="${esc(p.news)}">${Math.round(a * 100)}%</span>`;
}

export function connectionHtml(report) {
  const c = report?.connection?.status, t = report?.my_team;
  if (c === "connected") return `<span class="dot on"></span><span>${esc(t?.team_name || "Connected")}</span>`;
  if (c === "expired") return `<span class="dot warn"></span><span>Login expired — open FPL</span>`;
  if (t) return `<span class="dot warn"></span><span>${esc(t.team_name)} (public)</span>`;
  return `<span class="dot"></span><span>Not connected</span>`;
}

export function toast(msg, ms = 3000) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

export async function requestRefresh() {
  const res = await chrome.runtime.sendMessage({ type: "refresh" });
  if (!res?.ok) throw new Error(res?.error || "Refresh failed");
  return res;
}

/** Promise-based confirm dialog (needs the <dialog id="confirm"> markup). */
export function confirmDialog(title, html, yesLabel = "Apply") {
  const dlg = $("#confirm");
  $("#confirmTitle").textContent = title;
  $("#confirmBody").innerHTML = html;
  $("#confirmYes").textContent = yesLabel;
  dlg.showModal();
  return new Promise(resolve => {
    const done = v => { dlg.close(); $("#confirmYes").onclick = $("#confirmNo").onclick = null; resolve(v); };
    $("#confirmYes").onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
    dlg.oncancel = () => done(false);
  });
}

/** Ask the background worker to save a change; shows the outcome as a toast. */
export async function applyChange(msg, button) {
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "Saving…"; }
  try {
    const res = await chrome.runtime.sendMessage({ type: "apply", ...msg });
    toast(res?.ok ? `✓ ${res.message}` : res?.error || "Couldn't save the change", res?.ok ? 5000 : 8000);
    return !!res?.ok;
  } finally { if (button) { button.disabled = false; button.textContent = label; } }
}
