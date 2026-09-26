import { FPL, getCachedReport } from "./lib/fpl-api.js";
import { $, applyChange, availPill, connectionHtml, deadlineText, esc, money, num, requestRefresh, toast } from "./lib/ui.js";

const openDash = tab => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${tab ? "#" + tab : ""}`) });

function render(d) {
  const gw = d.gameweek || {};
  $("#meta").textContent = gw.next_gw ? `GW${gw.next_gw} · ${deadlineText(gw.next_deadline)}` : "Season finished";
  $("#conn").innerHTML = connectionHtml(d);
  const c = d.captain || {}, m = d.my_team, conn = d.connection?.status;
  let html = "";
  if (conn !== "connected") {
    html += `<div class="notice" style="margin:0">${conn === "expired" ? "FPL login expired." : "Not connected to your FPL account."}
      <a href="${FPL}/my-team" target="_blank">Open FPL &amp; log in</a>, then press Refresh.</div>`;
  }
  if (m) {
    const flagged = m.lineup.starters.filter(p => p.availability < 1);
    html += `<div class="card"><h2>${esc(m.team_name)}</h2>
      <div class="line2"><span>Your captain</span><b>${esc(m.lineup.captain)} (${num(m.lineup.starters.find(p => p.name === m.lineup.captain)?.xp_next)} xP)</b></div>
      <div class="line2"><span>Bank${m.source === "account" ? " · FTs" : ""}</span><b>${money(m.bank)}${m.source === "account" ? " · " + (m.transfer_status === "unlimited" ? "∞" : m.free_transfers) : ""}</b></div>
      <p style="margin:8px 0 0">${esc(m.advice)}</p>
      ${flagged.length ? `<p style="margin:6px 0 0">⚠️ In your XI: ${flagged.map(p => esc(p.name) + availPill(p)).join(", ")}</p>` : ""}
      ${m.source === "account" && m.lineup_diff?.gain >= 0.05 ? `<div class="line2" style="margin-top:8px;align-items:center">
        <span>Best lineup is <b>+${num(m.lineup_diff.gain)} xP</b> better</span>
        <button class="small apply" id="applyLineup">Apply</button></div>` : ""}
    </div>`;
  }
  const dr = d.draft;
  if (dr) {
    const mv = dr.moves?.[0];
    html += `<div class="card"><h2>Draft · ${esc(dr.league?.name || dr.entry?.name || "")}</h2>
      ${dr.next_pick ? `<div class="line2"><span>Next draft pick</span><b>${esc(dr.next_pick.name)}</b></div>` : ""}
      ${mv ? `<div class="line2"><span>Top ${esc(mv.kind)}</span><b>${esc(mv.out.name)} → ${esc(mv.in.name)} (+${num(mv.gain)})</b></div>` : ""}
      ${dr.lineup_diff?.gain >= 0.05 ? `<div class="line2"><span>Lineup</span><b>+${num(dr.lineup_diff.gain)} xP available</b></div>` : ""}
      ${!dr.next_pick && !mv && !(dr.lineup_diff?.gain >= 0.05) ? '<div class="muted">Nothing to change right now.</div>' : ""}</div>`;
  }
  html += `<div class="card"><h2>Best captain overall</h2>
    <div class="big">${esc(c.captain ?? "–")}</div>
    <div class="muted">${num(c.score)} xP · Vice ${esc(c.vice_captain ?? "–")}</div></div>`;
  const diffs = (d.insights?.differentials || []).slice(0, 3);
  if (diffs.length) html += `<div class="card"><h2>Differentials</h2>${diffs.map(p =>
    `<div class="line2"><span>${esc(p.name)} <span class="muted">${esc(p.team_short)} ${esc(p.position)}</span></span><span>${money(p.now_cost)} · ${num(p.selected_by)}%</span></div>`).join("")}</div>`;
  $("#body").innerHTML = html;
  const btn = $("#applyLineup");
  if (btn) btn.addEventListener("click", () => {
    if (btn.dataset.armed) return applyChange({ action: "lineup" }, btn);
    btn.dataset.armed = 1; btn.textContent = "Tap to confirm";
    setTimeout(() => { if (!btn.disabled) { delete btn.dataset.armed; btn.textContent = "Apply"; } }, 4000);
  });
}

$("#open").addEventListener("click", () => openDash());
$("#refresh").addEventListener("click", async () => {
  const b = $("#refresh"); b.disabled = true; b.textContent = "Analysing…";
  try { await requestRefresh(); } catch (e) { toast(e.message, 4000); }
  finally { b.disabled = false; b.textContent = "Refresh"; }
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.report?.newValue) render(ch.report.newValue); });

(async () => {
  const { report, error } = await getCachedReport();
  if (report) render(report);
  else { $("#body").innerHTML = `<div class="empty">${error ? esc(error) : "Fetching FPL data…"}</div>`; }
  if (!report) requestRefresh().catch(e => toast(e.message, 4000));
})();
