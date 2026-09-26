import { FPL, getCachedReport, getSettings, saveSettings } from "./lib/fpl-api.js";
import { $, availPill, connectionHtml, deadlineText, esc, money, num, requestRefresh, toast } from "./lib/ui.js";

let DATA = null, sortKey = "xp_next", sortDir = -1;
const H = () => DATA?.horizon ?? 5;

function fdrChips(fixtures) {
  if (!fixtures || !fixtures.length) return '<span class="fdr f5">BLANK</span>';
  return fixtures.map(f => `<span class="fdr f${f.difficulty}" title="GW${f.gw}">${esc(f.opponent)}${f.home ? "" : "·a"}</span>`).join("");
}

function playerTable(rows, cols) {
  if (!rows || !rows.length) return '<div class="empty">Nothing to show.</div>';
  const defs = {
    name: ["Player", p => `<b>${esc(p.name)}</b>${availPill(p)} <span class="muted">${esc(p.team_short)} ${esc(p.position)}</span>`],
    now_cost: ["Price", p => money(p.now_cost), true], xp_next: ["xP next", p => num(p.xp_next), true],
    xp_horizon: [`xP ${H()}GW`, p => num(p.xp_horizon), true], value: ["xP/£", p => num(p.value, 2), true],
    selected_by: ["Owned", p => num(p.selected_by) + "%", true], form: ["Form", p => num(p.form), true],
    next_fixture: ["Next", p => esc(p.next_fixture)],
  };
  return `<div class="scroll"><table><thead><tr>${cols.map(c => `<th class="${defs[c][2] ? "num" : ""}">${defs[c][0]}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(p => `<tr>${cols.map(c => `<td class="${defs[c][2] ? "num" : ""}">${defs[c][1](p)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function pitch(lineup) {
  if (!lineup) return '<div class="empty">No lineup.</div>';
  const shirt = p => `<div class="shirt ${p.availability < 1 ? "flag" : ""}" title="${esc(p.news || "")}">
      <b>${esc(p.name)}${p.name === lineup.captain ? '<span class="badge-c">C</span>' : p.name === lineup.vice_captain ? '<span class="badge-c">V</span>' : ""}</b>
      ${esc(p.team_short)} · ${money(p.now_cost)}<br><span class="xp">${num(p.xp_next)} xP</span></div>`;
  const rows = ["GKP", "DEF", "MID", "FWD"].map(pos =>
    `<div class="line">${lineup.starters.filter(p => p.position === pos).map(shirt).join("")}</div>`).join("");
  return `<div class="pitch">${rows}<div class="bench">${lineup.bench.map(shirt).join("")}</div></div>`;
}

function renderNotice(d) {
  const c = d.connection || {};
  let html = "";
  if (c.status !== "connected") {
    html = `<div class="notice"><b>${c.status === "expired" ? "Your FPL login has expired." : "Connect your FPL account"}</b> —
      <a href="${FPL}/my-team" target="_blank">open FPL and log in</a>, then come back and press Refresh.
      This unlocks your selling prices, free transfers and chips. ${d.my_team ? "" : "Or enter any team ID above to analyse it from public data."}
      ${c.error ? `<div class="muted" style="font-size:12px">${esc(c.error)}</div>` : ""}</div>`;
  }
  $("#notice").innerHTML = html;
}

function renderOverview(d) {
  const c = d.captain || {}, ins = d.insights || {};
  $("#overview").innerHTML = `
    <div class="grid">
      <div class="card"><h2>Captain pick</h2>
        <div class="big">${esc(c.captain ?? "–")}</div>
        <div class="muted">${num(c.score)} expected points · Vice: ${esc(c.vice_captain ?? "–")}</div>
        ${playerTable(c.options, ["name", "xp_next", "selected_by", "next_fixture"])}</div>
      <div class="card"><h2>Differentials (&lt;10% owned)</h2>
        ${playerTable(ins.differentials, ["name", "now_cost", "xp_horizon", "selected_by"])}</div>
      <div class="card"><h2>Injury &amp; doubt watch</h2>
        ${playerTable(ins.injury_watch, ["name", "selected_by", "next_fixture"])}</div>
      <div class="card"><h2>Best value by position</h2>
        ${["GKP", "DEF", "MID", "FWD"].map(pos => `<div class="muted" style="margin-top:6px">${pos}</div>
          ${playerTable((ins.value_picks || {})[pos], ["name", "now_cost", "value"])}`).join("")}</div>
      <div class="card"><h2>Most transferred in</h2>${playerTable((ins.most_transferred_in || []).slice(0, 6), ["name", "now_cost", "form"])}</div>
      <div class="card"><h2>Most transferred out</h2>${playerTable((ins.most_transferred_out || []).slice(0, 6), ["name", "now_cost", "form"])}</div>
    </div>`;
}

function transferRow(t) {
  return `<div class="transfer">
    <div><span class="out">▼ ${esc(t.out.name)}</span> → <span class="in">▲ ${esc(t.in.name)}</span>
      <div class="muted">${esc(t.in.team_short)} ${esc(t.in.position)} · ${money(t.in.now_cost)} · ${esc(t.in.next_fixture)}</div></div>
    <div class="num"><b>+${num(t.gain)}</b><div class="muted">${t.cost_change >= 0 ? "+" : ""}${num(t.cost_change)}m</div></div></div>`;
}

function renderMyTeam(d) {
  const m = d.my_team;
  if (!m) {
    $("#myteam").innerHTML = `<div class="card empty">Log in at <a href="${FPL}/my-team" target="_blank">fantasy.premierleague.com</a>
      and press Refresh — or type any team ID in the box above.<br>
      <span class="muted">A team ID is in the URL of the Points page: …/entry/<b>123456</b>/event/…</span></div>`;
    return;
  }
  const l = m.lineup, authed = m.source === "account";
  const chips = (m.chips || []).filter(c => c.status === "available");
  $("#myteam").innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <h2>${esc(m.team_name)} · ${esc(m.manager)} ${authed ? '<span class="pill good">Your account</span>' : '<span class="pill">Public data</span>'}</h2>
      <div class="stats">
        <div><span>Overall rank</span><b>${m.overall_rank ? Number(m.overall_rank).toLocaleString() : "–"}</b></div>
        <div><span>Points</span><b>${m.overall_points ?? "–"}</b></div>
        <div><span>Bank</span><b>${money(m.bank)}</b></div>
        <div><span>Team value</span><b>${money(m.team_value)}</b></div>
        ${authed ? `<div><span>Free transfers</span><b>${m.transfer_status === "unlimited" ? "∞" : m.free_transfers}</b></div>` : ""}
        <div><span>Best XI xP</span><b>${num(l.xp_next)}</b></div>
      </div>
      <div><b>Advice:</b> ${esc(m.advice)}</div>
      ${chips.length ? `<div class="chips">Chips available: ${chips.map(c => `<span class="pill">${esc(c.name)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="grid">
      <div class="card"><h2>Best XI (${esc(l.formation)})</h2>${pitch(l)}</div>
      <div class="card"><h2>Transfer suggestions</h2>
        ${m.transfers.length ? m.transfers.map(transferRow).join("") : '<div class="empty">No affordable upgrades found.</div>'}
        ${(m.double_transfers || []).length ? `<h2 style="margin-top:14px">Best double transfers</h2>` +
          m.double_transfers.map(x => `<div class="transfer"><div>${x.moves.map(t => `<span class="out">▼ ${esc(t.out.name)}</span> → <span class="in">▲ ${esc(t.in.name)}</span>`).join("<br>")}</div>
            <div class="num"><b>+${num(x.gain)}</b></div></div>`).join("") : ""}
        <p class="muted" style="font-size:12px">Gain = change in best-XI expected points over the next ${H()} gameweeks.
          ${authed ? "Budgets use your real selling prices." : "Public data: budgets use current prices; your selling prices may be lower."}</p>
      </div>
      <div class="card"><h2>Flagged players</h2>${playerTable(m.flagged, ["name", "now_cost", "next_fixture"])}</div>
    </div>`;
}

function renderOptimal(d) {
  const o = d.optimal_squad;
  if (!o) { $("#optimal").innerHTML = `<div class="card empty">${esc(d.optimal_error || "No data yet.")}</div>`; return; }
  $("#optimal").innerHTML = `
    <div class="card">
      <h2>Wildcard / Free Hit planner — best 15 for ${money(d.budget)}</h2>
      <div class="stats">
        <div><span>Formation</span><b>${esc(o.formation)}</b></div>
        <div><span>Cost</span><b>${money(o.total_cost)}</b></div>
        <div><span>In bank</span><b>${money(o.bank)}</b></div>
        <div><span>xP next GW</span><b>${num(o.xp_next)}</b></div>
        <div><span>xP ${H()} GWs</span><b>${num(o.xp_horizon)}</b></div>
      </div>
      ${pitch(o)}
      <p class="muted" style="font-size:12px">Solved exactly with integer programming: 2 GKP / 5 DEF / 5 MID / 3 FWD, max 3 per club,
        optimised for expected points over the next ${H()} gameweeks. Change the budget in Settings.</p>
    </div>`;
}

function renderFixtures(d) {
  const t = (d.insights || {}).fixture_ticker || [];
  $("#fixtures").innerHTML = `<div class="card"><h2>Fixture ticker — easiest first</h2>
    <div class="scroll"><table><thead><tr><th>Team</th><th class="num">Avg FDR</th><th>Next ${H()} GWs</th></tr></thead>
    <tbody>${t.map(r => `<tr><td><b>${esc(r.team_short)}</b></td><td class="num">${num(r.fdr_avg, 2)}</td><td>${fdrChips(r.fixtures)}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted" style="font-size:12px">Colours use FPL's official difficulty rating (1 easy → 5 hard). "·a" = away.</p></div>`;
}

function renderPlayers(d) {
  const sec = $("#players");
  if (!sec.dataset.ready) {
    sec.innerHTML = `<div class="card"><div class="filters">
        <input id="q" placeholder="Search player or team">
        <select id="pos"><option value="">All positions</option><option>GKP</option><option>DEF</option><option>MID</option><option>FWD</option></select>
        <select id="maxp"><option value="">Any price</option>${[4.5, 5, 5.5, 6, 6.5, 7, 8, 9, 10, 12].map(v => `<option value="${v}">≤ £${v}m</option>`).join("")}</select>
        <label class="muted" style="align-self:center"><input type="checkbox" id="fit"> Fit only</label>
      </div><div id="ptable"></div></div>`;
    ["q", "pos", "maxp", "fit"].forEach(id => $("#" + id).addEventListener("input", () => renderPlayerRows(DATA)));
    sec.dataset.ready = 1;
  }
  renderPlayerRows(d);
}

function renderPlayerRows(d) {
  const q = $("#q").value.toLowerCase(), pos = $("#pos").value, maxp = parseFloat($("#maxp").value), fit = $("#fit").checked;
  const rows = (d.players || []).filter(p =>
    (!q || `${p.name} ${p.full_name} ${p.team}`.toLowerCase().includes(q)) &&
    (!pos || p.position === pos) && (isNaN(maxp) || p.now_cost <= maxp) && (!fit || p.availability >= 1));
  rows.sort((a, b) => ((a[sortKey] ?? 0) > (b[sortKey] ?? 0) ? 1 : -1) * sortDir);
  const cols = [["name", "Player"], ["now_cost", "£"], ["xp_next", "xP next"], ["xp_horizon", `xP ${H()}GW`],
                ["value", "xP/£"], ["form", "Form"], ["total_points", "Pts"], ["xg", "xG"], ["xa", "xA"],
                ["selected_by", "Own%"], ["fixtures", "Fixtures"]];
  const plain = k => ["name", "fixtures"].includes(k);
  const cell = (p, k) => k === "name" ? `<b>${esc(p.name)}</b>${availPill(p)} <span class="muted">${esc(p.team_short)} ${esc(p.position)}</span>`
    : k === "fixtures" ? fdrChips(p.fixtures) : num(p[k], k === "value" ? 2 : k === "total_points" ? 0 : 1);
  $("#ptable").innerHTML = `<div class="muted" style="margin-bottom:6px">${rows.length} players</div><div class="scroll"><table>
    <thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${plain(k) ? "" : "num"}">${l}${sortKey === k ? (sortDir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
    <tbody>${rows.slice(0, 300).map(p => `<tr>${cols.map(([k]) => `<td class="${plain(k) ? "" : "num"}">${cell(p, k)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  $("#ptable").querySelectorAll("th[data-k]").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (k === "fixtures") return;
    sortDir = sortKey === k ? -sortDir : -1; sortKey = k; renderPlayerRows(DATA);
  }));
}

async function renderSettings() {
  const s = await getSettings();
  $("#settings").innerHTML = `<div class="card" style="max-width:520px"><h2>Settings</h2>
    <div class="filters" style="flex-direction:column;align-items:stretch">
      <label>Planning horizon (gameweeks)<br><input id="sHorizon" type="number" min="1" max="10" value="${s.horizon}"></label>
      <label>Optimal squad budget (£m)<br><input id="sBudget" type="number" min="80" max="120" step="0.1" value="${s.budget}"></label>
      <label>Team ID for public mode (used when not logged in)<br><input id="sTeam" inputmode="numeric" value="${esc(s.teamId)}"></label>
      <div><button id="sSave">Save &amp; refresh</button> <button id="sDisconnect" class="ghost" style="color:var(--ink);border-color:var(--line)">Forget FPL login</button></div>
    </div>
    <p class="muted" style="font-size:12px">Your FPL login token is kept in memory only and is sent to fantasy.premierleague.com — nowhere else.
      It's cleared when Chrome closes; just open FPL again to reconnect.</p></div>`;
  $("#sSave").addEventListener("click", async () => {
    const horizon = Math.max(1, Math.min(10, parseInt($("#sHorizon").value) || 5));
    const budget = Math.max(80, Math.min(120, parseFloat($("#sBudget").value) || 100));
    const teamId = $("#sTeam").value.trim();
    if (teamId && !/^\d+$/.test(teamId)) return toast("Team ID should be a number");
    await saveSettings({ horizon, budget, teamId });
    $("#teamId").value = teamId;
    await doRefresh();
  });
  $("#sDisconnect").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "disconnect" });
    toast("FPL login forgotten");
  });
}

function render(d) {
  DATA = d;
  const gw = d.gameweek || {};
  $("#meta").textContent = gw.next_gw
    ? `GW${gw.next_gw} · deadline ${deadlineText(gw.next_deadline)} · updated ${new Date(d.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Season finished";
  $("#conn").innerHTML = connectionHtml(d);
  $("#teamId").classList.toggle("hidden", d.connection?.status === "connected");
  renderNotice(d); renderOverview(d); renderMyTeam(d); renderOptimal(d); renderFixtures(d); renderPlayers(d);
}

async function doRefresh() {
  const btn = $("#refresh");
  btn.disabled = true; btn.textContent = "Analysing…";
  try { await requestRefresh(); toast("Updated"); }
  catch (e) { toast(e.message, 5000); }
  finally { btn.disabled = false; btn.textContent = "Refresh"; }
}

$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach(s => s.classList.toggle("hidden", s.id !== b.dataset.tab));
});
$("#refresh").addEventListener("click", async () => {
  const team = $("#teamId").value.trim();
  if (team && !/^\d+$/.test(team)) return toast("Team ID should be a number");
  await saveSettings({ teamId: team });
  doRefresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.report?.newValue) render(changes.report.newValue);
});

(async () => {
  const s = await getSettings();
  $("#teamId").value = s.teamId;
  if (location.hash) $(`#tabs button[data-tab="${location.hash.slice(1)}"]`)?.click();
  renderSettings();
  const { report, error } = await getCachedReport();
  if (report) render(report);
  else $("#meta").textContent = error ? `Error: ${error}` : "Fetching FPL data…";
  if (!report || Date.now() - new Date(report.updated) > 30 * 60 * 1000) doRefresh();
})();
