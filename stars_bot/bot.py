"""FPL AI Telegram bot: free picks, a Premium pass paid in Telegram Stars,
licence keys for the Chrome extension, and Premium deadline alerts.

Telegram rules this follows (https://core.telegram.org/bots/payments-stars):
* digital goods are paid in Stars -> currency "XTR", no provider token;
* every pre_checkout_query must be answered within 10 seconds;
* the bot must answer /paysupport (and show its terms) for payment disputes;
* the bot can refund with refundStarTransaction.
"""
from __future__ import annotations

import html
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .licence import sign_licence
from .store import DAY, Store

log = logging.getLogger("stars_bot")
PAYLOAD = "premium"          # invoice payload prefix: premium:<days>:<user_id>
ALERT_WINDOWS_H = (24, 2)    # Premium deadline alerts this many hours before
RENEW_REMINDER_DAYS = 3


@dataclass
class Config:
    price_stars: int = 150
    premium_days: int = 30
    admin_ids: set = field(default_factory=set)
    support: str = ""                 # e.g. "@your_username" for /paysupport
    extension_url: str = ""           # Chrome Web Store / GitHub link


def esc(v) -> str:
    return html.escape(str(v if v is not None else ""))


def fmt_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%d %b %Y")


class StarsBot:
    def __init__(self, api, store: Store, analyzer, private_key, config: Config | None = None):
        self.api, self.store, self.analyzer, self.key = api, store, analyzer, private_key
        self.cfg = config or Config()
        self.commands = {
            "/start": self.cmd_start, "/help": self.cmd_start,
            "/captain": self.cmd_captain, "/differentials": self.cmd_differentials,
            "/premium": self.cmd_premium, "/buy": self.cmd_premium,
            "/status": self.cmd_status, "/key": self.cmd_key,
            "/team": self.cmd_team, "/myteam": self.cmd_myteam,
            "/paysupport": self.cmd_paysupport, "/terms": self.cmd_terms,
            "/refund": self.cmd_refund, "/reply": self.cmd_reply,
        }

    # ------------------------------------------------------------ dispatch --
    def handle_update(self, update: dict) -> None:
        try:
            if "pre_checkout_query" in update:
                self.on_pre_checkout(update["pre_checkout_query"])
            elif "message" in update:
                self.on_message(update["message"])
        except Exception:
            log.exception("update %s failed", update.get("update_id"))

    def on_message(self, msg: dict) -> None:
        user = msg.get("from") or {}
        if not user.get("id"):
            return
        chat = msg["chat"]["id"]
        self.store.touch_user(user["id"], chat, user.get("first_name", ""))
        if "successful_payment" in msg:
            return self.on_paid(user["id"], chat, msg["successful_payment"])
        if msg.get("refunded_payment"):
            charge = msg["refunded_payment"].get("telegram_payment_charge_id")
            if charge:
                self.store.mark_refunded(charge)
            return
        text = (msg.get("text") or "").strip()
        if not text.startswith("/"):
            return self.api.send(chat, "Send /help to see what I can do.")
        cmd, *args = text.split()
        cmd = cmd.split("@")[0].lower()
        if cmd == "/start" and args and args[0] == "premium":
            return self.cmd_premium(user["id"], chat, [])
        handler = self.commands.get(cmd)
        if handler:
            handler(user["id"], chat, args)
        else:
            self.api.send(chat, "Unknown command. Send /help.")

    # ---------------------------------------------------------------- free --
    def cmd_start(self, uid, chat, args):
        p = self.cfg
        self.api.send(chat, (
            "⚽ <b>FPL AI</b> — expected points, captain picks and transfer advice.\n\n"
            "<b>Free</b>\n/captain — best captain this gameweek\n/differentials — low-owned picks\n"
            "/team &lt;id&gt; — save your FPL team ID\n\n"
            f"<b>Premium</b> — ⭐{p.price_stars} for {p.premium_days} days\n"
            "• /myteam — captain, lineup and transfers for your team\n"
            "• Deadline alerts here 24h and 2h before every deadline\n"
            "• Unlocks the Chrome extension: apply changes + autopilot, FPL Draft tab, transfer planner\n\n"
            "/premium — buy · /status — your plan · /key — extension key\n"
            "/terms · /paysupport"
            + (f"\n\nChrome extension: {esc(p.extension_url)}" if p.extension_url else "")))

    def cmd_captain(self, uid, chat, args):
        d = self.analyzer.data()
        c, gw = d["captain"], d["gameweek"]
        lines = [f"<b>GW{esc(gw.get('next_gw'))} captain:</b> {esc(c['captain'])} ({c['score']:.1f} xP)",
                 f"Vice: {esc(c['vice_captain'])}", "", "<b>Top options</b>"]
        lines += [f"{i}. {esc(o['name'])} {esc(o.get('team_short', ''))} — {o['xp_next']:.1f} xP · {esc(o.get('next_fixture', ''))}"
                  for i, o in enumerate(c["options"], 1)]
        self.api.send(chat, "\n".join(lines))

    def cmd_differentials(self, uid, chat, args):
        diffs = self.analyzer.data()["insights"]["differentials"][:6]
        if not diffs:
            return self.api.send(chat, "No differentials right now.")
        self.api.send(chat, "<b>Differentials (&lt;10% owned)</b>\n" + "\n".join(
            f"• {esc(p['name'])} {esc(p['team_short'])} {esc(p['position'])} — £{p['now_cost']}m · "
            f"{p['selected_by']:.1f}% · {p['xp_horizon']:.1f} xP" for p in diffs))

    def cmd_team(self, uid, chat, args):
        if not args or not args[0].isdigit():
            return self.api.send(chat, "Send <code>/team 123456</code>. Your team ID is in the URL of your FPL "
                                       "Points page: fantasy.premierleague.com/entry/<b>123456</b>/event/…")
        self.store.set_team(uid, int(args[0]))
        self.api.send(chat, f"✅ Team {esc(args[0])} saved."
                      + ("" if self.store.is_premium(uid) else " Get /premium for team advice and deadline alerts."))

    # ------------------------------------------------------------- premium --
    def cmd_myteam(self, uid, chat, args):
        if not self.store.is_premium(uid):
            return self.upsell(chat, "Team advice is a Premium feature.")
        team_id = (self.store.user(uid) or {}).get("team_id")
        if not team_id:
            return self.api.send(chat, "First send <code>/team 123456</code> with your FPL team ID.")
        self.api.send(chat, self.team_message(team_id))

    def team_message(self, team_id: int, heading: str = "") -> str:
        m = self.analyzer.team(team_id)
        l = m["lineup"]
        lines = [heading] if heading else []
        lines += [f"<b>{esc(m['team_name'])}</b> · bank £{m['bank']}m",
                  f"Captain: <b>{esc(l['captain'])}</b> · Vice: {esc(l['vice_captain'])}",
                  f"Best XI ({esc(l['formation'])}): {l['xp_next']:.1f} xP",
                  "Bench: " + ", ".join(esc(p["name"]) for p in l["bench"])]
        flagged = [p for p in l["starters"] if p.get("availability", 1) < 1]
        for p in flagged:
            lines.append(f"⚠️ {esc(p['name'])}: {esc(p.get('news') or 'flagged')}")
        lines.append("")
        lines.append(esc(m["advice"]))
        for t in m["transfers"][:3]:
            lines.append(f"• {esc(t['out']['name'])} → {esc(t['in']['name'])} (+{t['gain']:.1f})")
        return "\n".join(lines)

    def upsell(self, chat, why: str):
        self.api.send(chat, f"🔒 {esc(why)}\nGet Premium: ⭐{self.cfg.price_stars} for "
                            f"{self.cfg.premium_days} days — /premium")

    def cmd_premium(self, uid, chat, args):
        p = self.cfg
        until = self.store.premium_until(uid)
        note = f" Adds {p.premium_days} days to your current plan (ends {fmt_date(until)})." if until > time.time() else ""
        self.api.call(
            "sendInvoice", chat_id=chat,
            title=f"FPL AI Premium — {p.premium_days} days",
            description=("Team advice and deadline alerts in Telegram, plus a key that unlocks the Chrome "
                         "extension's apply/autopilot, FPL Draft tab and transfer planner." + note)[:255],
            payload=f"{PAYLOAD}:{p.premium_days}:{uid}",
            currency="XTR",
            prices=[{"label": f"Premium {p.premium_days} days", "amount": p.price_stars}],
        )

    def on_pre_checkout(self, q: dict) -> None:
        parts = (q.get("invoice_payload") or "").split(":")
        ok = (len(parts) == 3 and parts[0] == PAYLOAD and parts[1] == str(self.cfg.premium_days)
              and parts[2] == str(q["from"]["id"]) and q.get("currency") == "XTR"
              and q.get("total_amount") == self.cfg.price_stars)
        self.api.call("answerPreCheckoutQuery", pre_checkout_query_id=q["id"], ok=ok,
                      error_message=None if ok else "This offer has changed — send /premium for a new invoice.")

    def on_paid(self, uid: int, chat: int, sp: dict) -> None:
        parts = sp.get("invoice_payload", "").split(":")
        days = int(parts[1]) if len(parts) == 3 and parts[1].isdigit() else self.cfg.premium_days
        until = self.store.record_payment(sp["telegram_payment_charge_id"], uid,
                                          sp.get("total_amount", 0), sp.get("invoice_payload", ""), days)
        if until is None:
            return  # duplicate update
        log.info("payment %s from %s: %s Stars", sp["telegram_payment_charge_id"], uid, sp.get("total_amount"))
        self.api.send(chat, f"⭐ Thanks! Premium is active until <b>{fmt_date(until)}</b>.")
        self.send_key(uid, chat)
        if not (self.store.user(uid) or {}).get("team_id"):
            self.api.send(chat, "Send <code>/team 123456</code> with your FPL team ID to get deadline alerts.")

    def send_key(self, uid: int, chat: int) -> None:
        until = self.store.premium_until(uid)
        key = sign_licence(self.key, uid, until)
        self.api.send(chat, "🔑 <b>Your Chrome extension key</b> (valid until "
                            f"{fmt_date(until)}):\n\n<code>{esc(key)}</code>\n\n"
                            "Open the extension → Dashboard → Settings → Premium, paste the key and press "
                            "<b>Activate</b>. After you renew, send /key for a new one.")

    def cmd_key(self, uid, chat, args):
        if not self.store.is_premium(uid):
            return self.upsell(chat, "You don't have Premium yet.")
        self.send_key(uid, chat)

    def cmd_status(self, uid, chat, args):
        until = self.store.premium_until(uid)
        team = (self.store.user(uid) or {}).get("team_id")
        if until > time.time():
            text = f"⭐ Premium until <b>{fmt_date(until)}</b>. /premium adds {self.cfg.premium_days} more days."
        else:
            text = "Free plan. /premium to upgrade."
        self.api.send(chat, text + f"\nFPL team: {esc(team) if team else 'not set — /team 123456'}")

    # ---------------------------------------------------- support & refunds --
    def cmd_terms(self, uid, chat, args):
        p = self.cfg
        self.api.send(chat, (
            "<b>Terms</b>\n"
            f"• Premium costs ⭐{p.price_stars} Telegram Stars for {p.premium_days} days and does not renew "
            "automatically. Buying again adds days.\n"
            "• FPL AI gives estimates, not guarantees. You decide every change to your team; the extension "
            "only saves changes you confirm or turn on (autopilot).\n"
            "• FPL AI is not affiliated with the Premier League or Fantasy Premier League.\n"
            "• Refunds: within 7 days of purchase if Premium didn't work for you — use /paysupport.\n"
            "• We store your Telegram ID, FPL team ID and payment records only to provide the service."))

    def cmd_paysupport(self, uid, chat, args):
        last = self.store.last_payment(uid)
        ref = f"\nPayment ID: <code>{esc(last['charge_id'])}</code>" if last else ""
        if args:
            for admin in self.cfg.admin_ids:
                self._safe_send(admin, f"💬 /paysupport from <code>{uid}</code>:\n{esc(' '.join(args))}{ref}")
            return self.api.send(chat, "Thanks — we got your message and will reply here soon.")
        contact = f"message {esc(self.cfg.support)} or " if self.cfg.support else ""
        self.api.send(chat, f"💬 Payment help: {contact}send <code>/paysupport</code> followed by what went wrong. "
                            f"We'll sort it out, including refunds (see /terms).{ref}")

    def cmd_refund(self, uid, chat, args):
        if uid not in self.cfg.admin_ids:
            return self.api.send(chat, "Unknown command. Send /help.")
        if not args:
            return self.api.send(chat, "Usage: <code>/refund &lt;payment ID&gt;</code>")
        pay = self.store.payment(args[0])
        if not pay:
            return self.api.send(chat, "No such payment.")
        if pay["refunded"]:
            return self.api.send(chat, "Already refunded.")
        self.api.call("refundStarTransaction", user_id=pay["user_id"], telegram_payment_charge_id=pay["charge_id"])
        self.store.mark_refunded(pay["charge_id"])
        self.api.send(chat, f"Refunded ⭐{pay['amount']} to user {pay['user_id']}.")
        try:
            self.api.send(self.store.user(pay["user_id"])["chat_id"],
                          f"↩️ Your payment of ⭐{pay['amount']} was refunded and your Premium was shortened. "
                          "Extension keys already issued stop working when they expire.")
        except Exception:
            log.warning("could not tell user %s about the refund", pay["user_id"])

    def cmd_reply(self, uid, chat, args):
        if uid not in self.cfg.admin_ids:
            return self.api.send(chat, "Unknown command. Send /help.")
        if len(args) < 2 or not args[0].isdigit() or not self.store.user(int(args[0])):
            return self.api.send(chat, "Usage: <code>/reply &lt;user ID&gt; &lt;message&gt;</code>")
        self.api.send(self.store.user(int(args[0]))["chat_id"], "💬 Support: " + esc(" ".join(args[1:])))
        self.api.send(chat, "Sent.")

    # -------------------------------------------------------------- alerts --
    def run_alerts(self, now: float | None = None) -> int:
        """Deadline alerts for Premium users + renewal reminders. Safe to call often."""
        now = now or time.time()
        sent = 0
        for u in self.store.premium_users(now):
            left = u["premium_until"] - now
            if left < RENEW_REMINDER_DAYS * DAY and self.store.mark_sent(f"renew:{u['user_id']}:{u['premium_until']}"):
                self._safe_send(u["chat_id"], f"⏳ Your Premium ends {fmt_date(u['premium_until'])}. "
                                              "/premium to add another month, then /key for a new extension key.")
                sent += 1
        gw = self.analyzer.data()["gameweek"]
        if not gw.get("next_deadline"):
            return sent
        deadline = datetime.fromisoformat(gw["next_deadline"].replace("Z", "+00:00")).timestamp()
        hours = (deadline - now) / 3600
        window = next((w for w in sorted(ALERT_WINDOWS_H) if 0 < hours <= w), None)
        if window is None:
            return sent
        for u in self.store.premium_users(now):
            if not u["team_id"] or not self.store.mark_sent(f"dl:{gw['next_gw']}:{window}:{u['user_id']}"):
                continue
            try:
                h = f"⏰ <b>GW{gw['next_gw']} deadline in {hours:.0f}h</b>" if hours >= 1 else \
                    f"⏰ <b>GW{gw['next_gw']} deadline in {hours * 60:.0f} min</b>"
                self._safe_send(u["chat_id"], self.team_message(u["team_id"], heading=h))
                sent += 1
            except Exception:
                log.exception("alert for %s failed", u["user_id"])
        return sent

    def _safe_send(self, chat, text):
        try:
            self.api.send(chat, text)
        except Exception as e:
            log.warning("send to %s failed: %s", chat, e)
