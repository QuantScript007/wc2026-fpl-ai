import { DRAFT, FPL, getCachedReport, getSettings, saveSettings } from "./lib/fpl-api.js";
import { transferCost } from "./lib/core.js";
import { $, applyChange, availPill, confirmDialog, connectionHtml, deadlineText, esc, money, num, requestRefresh, toast } from "./lib/ui.js";

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
      ${esc(p.team_short)}${p.now_cost ? ` · ${money(p.now_cost)}` : ""}<br><span class="xp">${num(p.xp_next)} xP</span></div>`;
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

function transferRow(t, i, canApply) {
  return `<div class="transfer">
    <div><span class="out">▼ ${esc(t.out.name)}</span> → <span class="in">▲ ${esc(t.in.name)}</span>
      <div class="muted">${esc(t.in.team_short)} ${esc(t.in.position)} · ${money(t.in.now_cost)} · ${esc(t.in.next_fixture)}</div>
      ${canApply ? `<button class="small apply" data-act="transfer" data-i="${i}">Make transfer</button>` : ""}</div>
    <div class="num"><b>+${num(t.gain)}</b><div class="muted">${t.cost_change >= 0 ? "+" : ""}${num(t.cost_change)}m</div></div></div>`;
}

function lineupCard(m) {
  const diff = m.lineup_diff, authed = m.source === "account";
  if (!authed) return "";
  if (!diff) return "";
  const better = diff.gain >= 0.05;
  return `<div class="card" style="margin-bottom:14px"><h2>Your saved lineup vs the best one</h2>
    <div class="diff"><div><b>${num(diff.current_xp)}</b> xP now → <b>${num(diff.best_xp)}</b> xP best
      ${better ? `<span class="pill good">+${num(diff.gain)}</span>` : '<span class="pill">already optimal</span>'}
      ${diff.changes.length ? `<ul>${diff.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}</div>
      ${better ? '<button class="apply" data-act="lineup">Apply best lineup</button>' : ""}</div>
    ${DATA.autopilot ? `<p class="muted" style="font-size:12px;margin-bottom:0">Autopilot ${DATA.autopilot.ok ? "last saved" : "last failed"}
      ${new Date(DATA.autopilot.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: ${esc(DATA.autopilot.message)}</p>` : ""}
  </div>`;
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
      ${authed ? "" : `<p class="muted" style="font-size:12px;margin-bottom:0">Log in to FPL to let the extension apply changes for you.</p>`}
    </div>
    ${lineupCard(m)}
    <div class="grid">
      <div class="card"><h2>Best XI (${esc(l.formation)})</h2>${pitch(l)}</div>
      <div class="card"><h2>Transfer suggestions</h2>
        ${m.transfers.length ? m.transfers.map((t, i) => transferRow(t, i, authed)).join("") : '<div class="empty">No affordable upgrades found.</div>'}
        ${(m.double_transfers || []).length ? `<h2 style="margin-top:14px">Best double transfers</h2>` +
          m.double_transfers.map((x, i) => `<div class="transfer"><div>${x.moves.map(t => `<span class="out">▼ ${esc(t.out.name)}</span> → <span class="in">▲ ${esc(t.in.name)}</span>`).join("<br>")}
            ${authed ? `<br><button class="small apply" data-act="double" data-i="${i}">Make both</button>` : ""}</div>
            <div class="num"><b>+${num(x.gain)}</b></div></div>`).join("") : ""}
        <p class="muted" style="font-size:12px">Gain = change in best-XI expected points over the next ${H()} gameweeks.
          ${authed ? "Budgets use your real selling prices. After a transfer the best lineup and captain are saved automatically." : "Public data: budgets use current prices; your selling prices may be lower."}</p>
      </div>
      <div class="card"><h2>Flagged players</h2>${playerTable(m.flagged, ["name", "now_cost", "next_fixture"])}</div>
    </div>`;
}

function renderDraft(d) {
  const r = d.draft, sec = $("#draft");
  if (!r) {
    sec.innerHTML = `<div class="card empty">${d.draft_error ? `<div class="warnline">${esc(d.draft_error)}</div><br>` : ""}
      Open <a href="${DRAFT}/team/my" target="_blank">FPL Draft</a> while logged in and your Draft team is picked up automatically —
      or enter your Draft team ID in <a href="#" data-goto="settings">Settings</a>.<br>
      <span class="muted">It's the number in the URL on your Draft points page: draft.premierleague.com/entry/<b>12345</b>/event/…</span></div>`;
    return;
  }
  const lg = r.league || {};
  const pre = lg.draft_status && lg.draft_status !== "post";
  const board = r.big_board || [];
  const fa = r.free_agents || {};
  const diff = r.lineup_diff;
  sec.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <h2>${esc(r.entry?.name || "Draft team")} · ${esc(lg.name || "")}</h2>
      <div class="stats">
        <div><span>League size</span><b>${lg.size ?? "–"}</b></div>
        <div><span>Draft</span><b>${pre ? "Not finished" : "Done"}</b></div>
        <div><span>Planning for</span><b>GW${r.draft_gw ?? r.gameweek?.next_gw ?? "–"}</b></div>
        ${r.lineup ? `<div><span>Best XI xP</span><b>${num(r.lineup.xp_next)}</b></div>` : ""}
      </div>
      ${r.next_pick ? `<div><b>Your next draft pick:</b> ${esc(r.next_pick.name)} <span class="muted">${esc(r.next_pick.team_short)} ${esc(r.next_pick.position)} · board #${r.next_pick.board_rank}</span></div>` : ""}
      ${diff ? `<div class="diff" style="margin-top:8px"><div>Lineup: <b>${num(diff.current_xp)}</b> xP now → <b>${num(diff.best_xp)}</b> best
          ${diff.gain >= 0.05 ? `<span class="pill good">+${num(diff.gain)}</span>` : '<span class="pill">already optimal</span>'}
          ${diff.changes.length ? `<ul>${diff.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}</div>
          ${diff.gain >= 0.05 ? '<button class="apply" data-act="draft-lineup">Apply best lineup</button>' : ""}</div>` : ""}
      <p class="muted" style="font-size:12px;margin-bottom:0">No prices, captains or club limits in Draft — only who's on your team matters.
        Saving to Draft is experimental: if Draft refuses, nothing changes and the right Draft page opens instead.</p>
    </div>
    <div class="grid">
      ${r.lineup ? `<div class="card"><h2>Best Draft XI (${esc(r.lineup.formation)})</h2>${pitch(r.lineup)}</div>` : ""}
      <div class="card"><h2>Waiver &amp; free-agent targets</h2>
        ${(r.moves || []).length ? r.moves.map((m, i) => `<div class="transfer">
          <div><span class="kind pill ${m.kind === "waiver" ? "warn" : "good"}">${esc(m.kind)}</span>
            <span class="out">▼ ${esc(m.out.name)}</span> → <span class="in">▲ ${esc(m.in.name)}</span>
            <div class="muted">${esc(m.in.team_short)} ${esc(m.in.position)} · ${esc(m.in.next_fixture)} · form ${num(m.in.form)}</div>
            <button class="small apply" data-act="draft-claim" data-i="${i}">${m.kind === "waiver" ? "Submit waiver claim" : "Sign now"}</button></div>
          <div class="num"><b>+${num(m.gain)}</b></div></div>`).join("")
          : `<div class="empty">${r.squad?.length ? "No free agent improves your team right now." : "Your Draft squad will appear once your draft is done."}</div>`}
        <p class="muted" style="font-size:12px">Gain = change in best-XI expected points over the next ${H()} gameweeks.</p>
      </div>
      <div class="card"><h2>Best free agents by position</h2>
        ${["GKP", "DEF", "MID", "FWD"].map(pos => `<div class="muted" style="margin-top:6px">${pos}</div>
          ${playerTable(fa[pos], ["name", "xp_next", "xp_horizon", "form"])}`).join("")}</div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Draft big board ${pre ? "— use this in the draft room" : ""}</h2>
      <div class="scroll"><table><thead><tr><th class="num">#</th><th>Player</th><th class="num">Season xP/gm</th><th class="num">Value over replacement</th><th>Next ${H()} GWs</th></tr></thead>
      <tbody>${board.slice(0, 80).map(p => `<tr class="${p.taken ? "taken" : ""}"><td class="num">${p.board_rank}</td>
        <td><b>${esc(p.name)}</b>${availPill(p)} <span class="muted">${esc(p.team_short)} ${esc(p.position)}</span>${p.taken ? ' <span class="pill">taken</span>' : ""}</td>
        <td class="num">${num(p.season_xp, 2)}</td><td class="num">${num(p.vorp, 2)}</td><td>${fdrChips(p.fixtures)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted" style="font-size:12px">Ranked by expected points per match above the best player you could still get at that position in a ${lg.size ?? 8}-team league.</p></div>`;
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
      <label>FPL Draft team ID (filled in automatically when you open Draft)<br><input id="sDraft" inputmode="numeric" value="${esc(s.draftEntryId)}"></label>
      <label class="switch"><input type="checkbox" id="sAuto" ${s.autoLineup ? "checked" : ""}>
        <span><b>Autopilot lineup</b> — before each deadline, automatically save the best XI, bench order and captain to your FPL team
        whenever it gains at least 0.5 xP. Never makes transfers.</span></label>
      <div><button id="sSave">Save &amp; refresh</button> <button id="sDisconnect" class="ghost" style="color:var(--ink);border-color:var(--line)">Forget FPL login</button></div>
    </div>
    <p class="muted" style="font-size:12px">Your FPL login token is kept in memory only and is sent to fantasy.premierleague.com — nowhere else.
      It's cleared when Chrome closes; just open FPL again to reconnect.</p></div>`;
  $("#sSave").addEventListener("click", async () => {
    const horizon = Math.max(1, Math.min(10, parseInt($("#sHorizon").value) || 5));
    const budget = Math.max(80, Math.min(120, parseFloat($("#sBudget").value) || 100));
    const teamId = $("#sTeam").value.trim();
    if (teamId && !/^\d+$/.test(teamId)) return toast("Team ID should be a number");
    const draftEntryId = $("#sDraft").value.trim();
    if (draftEntryId && !/^\d+$/.test(draftEntryId)) return toast("Draft team ID should be a number");
    const cur = await getSettings();
    await saveSettings({ horizon, budget, teamId, draftEntryId, autoLineup: $("#sAuto").checked,
                         draftLeagueId: draftEntryId === cur.draftEntryId ? cur.draftLeagueId : "" });
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
  renderNotice(d); renderOverview(d); renderMyTeam(d); renderDraft(d); renderOptimal(d); renderFixtures(d); renderPlayers(d);
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
document.addEventListener("click", async e => {
  const go = e.target.closest("[data-goto]");
  if (go) { e.preventDefault(); $(`#tabs button[data-tab="${go.dataset.goto}"]`)?.click(); return; }
  const b = e.target.closest("button[data-act]");
  if (!b || !DATA) return;
  const act = b.dataset.act, i = Number(b.dataset.i);
  const m = DATA.my_team, dr = DATA.draft;
  const deadline = `<p class="muted">Deadline: ${esc(deadlineText(DATA.gameweek?.next_deadline))}</p>`;
  if (act === "lineup") {
    const diff = m.lineup_diff;
    if (await confirmDialog("Apply the best lineup?", `<p>This saves to your real FPL team:</p>
        <ul>${(diff?.changes.length ? diff.changes : ["Reorder bench"]).map(c => `<li>${esc(c)}</li>`).join("")}</ul>
        <p>Expected: <b>${num(diff?.current_xp)}</b> → <b>${num(diff?.best_xp)}</b> xP. You can change it again any time before the deadline.</p>${deadline}`, "Save lineup"))
      applyChange({ action: "lineup" }, b);
  } else if (act === "transfer" || act === "double") {
    const moves = act === "transfer" ? [m.transfers[i]] : m.double_transfers[i].moves;
    const c = transferCost(moves, { bank: m.bank, freeTransfers: m.free_transfers, unlimited: m.transfer_status === "unlimited", sellPrices: m.sell_prices });
    if (!c.affordable) return toast("Not enough money in the bank for this now.");
    const ok = await confirmDialog(moves.length > 1 ? "Make these transfers?" : "Make this transfer?", `
      <ul>${moves.map(t => `<li>Sell <b>${esc(t.out.name)}</b> (${money(m.sell_prices?.[t.out.id] ?? t.out.now_cost)}) → buy <b>${esc(t.in.name)}</b> (${money(t.in.now_cost)})</li>`).join("")}</ul>
      <p>Bank after: <b>${money(c.bank_after)}</b>${c.hit ? ` · <span class="warnline">costs a −${c.hit} point hit</span>` : " · uses free transfers only"}</p>
      <p>Then the best lineup and captain for your new squad are saved too.</p>
      <p class="warnline">Transfers are confirmed on FPL straight away and can't be undone.</p>${deadline}`, c.hit ? `Confirm (−${c.hit} pts)` : "Confirm transfer");
    if (ok) applyChange({ action: "transfers", moves: moves.map(t => ({ out: t.out.id, in: t.in.id })) }, b);
  } else if (act === "draft-lineup") {
    const diff = dr.lineup_diff;
    if (await confirmDialog("Apply the best Draft lineup?", `<ul>${(diff?.changes || []).map(c => `<li>${esc(c)}</li>`).join("") || "<li>Reorder bench</li>"}</ul>
        <p class="muted">Experimental: if FPL Draft refuses, nothing changes and your Draft team page opens instead.</p>`, "Save lineup"))
      applyChange({ action: "draft-lineup" }, b);
  } else if (act === "draft-claim") {
    const mv = dr.moves[i];
    if (await confirmDialog(mv.kind === "waiver" ? "Submit this waiver claim?" : "Sign this free agent?", `
        <p>Drop <b>${esc(mv.out.name)}</b> → add <b>${esc(mv.in.name)}</b> (+${num(mv.gain)} xP over ${H()} GWs).</p>
        ${mv.kind === "waiver" ? "<p>Waiver claims are processed at the waiver deadline in priority order.</p>" : "<p class=\"warnline\">Free-agent signings happen immediately.</p>"}
        <p class="muted">Experimental: if FPL Draft refuses, nothing changes and the Draft transactions page opens instead.</p>`,
        mv.kind === "waiver" ? "Submit claim" : "Sign player"))
      applyChange({ action: "draft-claim", move: { out: mv.out.id, in: mv.in.id, kind: mv.kind } }, b);
  }
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
