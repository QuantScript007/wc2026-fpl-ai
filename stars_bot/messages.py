"""Telegram message texts (HTML) rendered from the analysis.

GitHub Actions renders these every hour and uploads them to the Cloudflare
Worker, which only relays them -- the Worker has no room for pandas.
"""
from __future__ import annotations

import html


def esc(v) -> str:
    return html.escape(str(v if v is not None else ""))


def captain_text(data: dict) -> str:
    c, gw = data["captain"], data["gameweek"]
    lines = [f"<b>GW{esc(gw.get('next_gw'))} captain:</b> {esc(c['captain'])} ({c['score']:.1f} xP)",
             f"Vice: {esc(c['vice_captain'])}", "", "<b>Top options</b>"]
    lines += [f"{i}. {esc(o['name'])} {esc(o.get('team_short', ''))} — {o['xp_next']:.1f} xP · "
              f"{esc(o.get('next_fixture', ''))}" for i, o in enumerate(c["options"], 1)]
    return "\n".join(lines)


def differentials_text(data: dict) -> str:
    diffs = data["insights"]["differentials"][:6]
    if not diffs:
        return "No differentials right now."
    return "<b>Differentials (&lt;10% owned)</b>\n" + "\n".join(
        f"• {esc(p['name'])} {esc(p['team_short'])} {esc(p['position'])} — £{p['now_cost']}m · "
        f"{p['selected_by']:.1f}% · {p['xp_horizon']:.1f} xP" for p in diffs)


def team_text(m: dict) -> str:
    """Advice for one manager's team (analysis.insights.analyze_my_team output)."""
    l = m["lineup"]
    lines = [f"<b>{esc(m['team_name'])}</b> · bank £{m['bank']}m",
             f"Captain: <b>{esc(l['captain'])}</b> · Vice: {esc(l['vice_captain'])}",
             f"Best XI ({esc(l['formation'])}): {l['xp_next']:.1f} xP",
             "Bench: " + ", ".join(esc(p["name"]) for p in l["bench"])]
    for p in l["starters"]:
        if p.get("availability", 1) < 1:
            lines.append(f"⚠️ {esc(p['name'])}: {esc(p.get('news') or 'flagged')}")
    lines += ["", esc(m["advice"])]
    lines += [f"• {esc(t['out']['name'])} → {esc(t['in']['name'])} (+{t['gain']:.1f})" for t in m["transfers"][:3]]
    return "\n".join(lines)
