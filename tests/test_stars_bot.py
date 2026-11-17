"""Tests for the Telegram Stars bot: invoices, pre-checkout, payments, licences, alerts."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from stars_bot.analysis import Analyzer
from stars_bot.bot import Config, StarsBot
from stars_bot.licence import generate_private_key, public_jwk, sign_licence, verify_licence
from stars_bot.store import DAY, Store

UID, CHAT, ADMIN = 1001, 5001, 9009


class FakeAPI:
    def __init__(self):
        self.calls = []

    def call(self, method, **params):
        self.calls.append((method, params))
        return True

    def send(self, chat_id, text, **kw):
        return self.call("sendMessage", chat_id=chat_id, text=text)

    def texts(self, chat=None):
        return [p["text"] for m, p in self.calls if m == "sendMessage" and (chat is None or p["chat_id"] == chat)]

    def last(self, method):
        return next(p for m, p in reversed(self.calls) if m == method)


@pytest.fixture
def key():
    return generate_private_key()


@pytest.fixture
def bot(fpl_data, mock_api, key):
    from scrapers.fpl import fetch_manager_team
    analyzer = Analyzer(fetch=lambda horizon: fpl_data, fetch_team=fetch_manager_team)
    return StarsBot(FakeAPI(), Store(), analyzer, key,
                    Config(price_stars=150, premium_days=30, admin_ids={ADMIN}))


def msg(text=None, uid=UID, **extra):
    m = {"message_id": 1, "from": {"id": uid, "first_name": "Ana"}, "chat": {"id": CHAT if uid == UID else uid}}
    if text is not None:
        m["text"] = text
    m.update(extra)
    return {"update_id": 1, "message": m}


def pay(bot, charge="ch_1", amount=150, uid=UID):
    bot.handle_update(msg(uid=uid, successful_payment={
        "currency": "XTR", "total_amount": amount, "invoice_payload": f"premium:30:{uid}",
        "telegram_payment_charge_id": charge}))


# ---- invoices & checkout -----------------------------------------------------

def test_premium_sends_stars_invoice(bot):
    bot.handle_update(msg("/premium"))
    inv = bot.api.last("sendInvoice")
    assert inv["currency"] == "XTR"
    assert inv["prices"] == [{"label": "Premium 30 days", "amount": 150}]
    assert inv["payload"] == f"premium:30:{UID}"
    assert "provider_token" not in inv  # Stars need no provider token


def test_start_deep_link_opens_invoice(bot):
    bot.handle_update(msg("/start premium"))
    assert bot.api.last("sendInvoice")["currency"] == "XTR"


def checkout(bot, **over):
    q = {"id": "q1", "from": {"id": UID}, "currency": "XTR", "total_amount": 150,
         "invoice_payload": f"premium:30:{UID}", **over}
    bot.handle_update({"update_id": 2, "pre_checkout_query": q})
    return bot.api.last("answerPreCheckoutQuery")


def test_pre_checkout_accepts_valid(bot):
    a = checkout(bot)
    assert a["ok"] is True and a["pre_checkout_query_id"] == "q1"


@pytest.mark.parametrize("over", [{"total_amount": 1}, {"currency": "USD"},
                                  {"invoice_payload": "premium:30:42"}, {"invoice_payload": "junk"}])
def test_pre_checkout_rejects_bad(bot, over):
    a = checkout(bot, **over)
    assert a["ok"] is False and a["error_message"]


# ---- payments ------------------------------------------------------------------

def test_payment_grants_premium_and_key(bot, key):
    pay(bot)
    assert bot.store.is_premium(UID)
    key_msg = next(t for t in bot.api.texts(CHAT) if "Chrome extension key" in t)
    token = key_msg.split("<code>")[1].split("</code>")[0]
    v = verify_licence(key.public_key(), token)
    assert v["ok"] and v["user"] == UID and v["exp"] == bot.store.premium_until(UID)


def test_duplicate_payment_update_ignored(bot):
    pay(bot); first = bot.store.premium_until(UID)
    pay(bot)
    assert bot.store.premium_until(UID) == first


def test_second_payment_extends(bot):
    pay(bot, "a"); first = bot.store.premium_until(UID)
    pay(bot, "b")
    assert bot.store.premium_until(UID) == first + 30 * DAY


def test_premium_commands_locked_for_free(bot):
    bot.handle_update(msg("/myteam"))
    bot.handle_update(msg("/key"))
    assert all("Premium" in t for t in bot.api.texts(CHAT))


def test_myteam_after_payment(bot):
    pay(bot)
    bot.handle_update(msg("/team 123"))
    bot.handle_update(msg("/myteam"))
    out = bot.api.texts(CHAT)[-1]
    assert "Test FC" in out and "Captain:" in out


# ---- refunds & support ---------------------------------------------------------

def test_admin_refund(bot):
    pay(bot, "ch_9")
    bot.handle_update(msg("/refund ch_9", uid=ADMIN))
    r = bot.api.last("refundStarTransaction")
    assert r == {"user_id": UID, "telegram_payment_charge_id": "ch_9"}
    assert not bot.store.is_premium(UID)
    assert bot.store.payment("ch_9")["refunded"] == 1


def test_refund_is_admin_only(bot):
    pay(bot, "ch_9")
    bot.handle_update(msg("/refund ch_9"))
    assert not any(m == "refundStarTransaction" for m, _ in bot.api.calls)


def test_paysupport_and_terms_exist(bot):
    bot.handle_update(msg("/terms"))
    bot.handle_update(msg("/paysupport my key does not work"))
    assert any("Terms" in t for t in bot.api.texts(CHAT))
    assert any("my key does not work" in t for t in bot.api.texts(ADMIN))


def test_free_commands(bot):
    bot.handle_update(msg("/captain"))
    bot.handle_update(msg("/differentials"))
    assert "captain" in bot.api.texts(CHAT)[0]


# ---- alerts --------------------------------------------------------------------

def test_deadline_alert_once_per_window(bot):
    pay(bot)
    bot.handle_update(msg("/team 123"))
    dl = datetime.fromisoformat(bot.analyzer.data()["gameweek"]["next_deadline"].replace("Z", "+00:00"))
    before = len(bot.api.texts(CHAT))
    t = (dl - timedelta(hours=20)).timestamp()
    bot.run_alerts(now=t); bot.run_alerts(now=t + 600)
    alerts = [x for x in bot.api.texts(CHAT)[before:] if "deadline in" in x]
    assert len(alerts) == 1
    bot.run_alerts(now=(dl - timedelta(hours=1)).timestamp())
    assert len([x for x in bot.api.texts(CHAT)[before:] if "deadline in" in x]) == 2


def test_no_alerts_for_free_users(bot):
    bot.handle_update(msg("/team 123"))
    dl = datetime.fromisoformat(bot.analyzer.data()["gameweek"]["next_deadline"].replace("Z", "+00:00"))
    bot.run_alerts(now=(dl - timedelta(hours=1)).timestamp())
    assert not [x for x in bot.api.texts(CHAT) if "deadline in" in x]


# ---- licence format shared with the extension ----------------------------------

def test_licence_expired_and_tampered(key):
    tok = sign_licence(key, 7, expires=1000, issued=1)
    assert verify_licence(key.public_key(), tok, now=999)["ok"]
    assert verify_licence(key.public_key(), tok, now=1000)["reason"] == "expired"
    head, payload, sig = tok.split(".")
    assert verify_licence(key.public_key(), f"{head}.{payload}x.{sig}")["ok"] is False
    assert verify_licence(generate_private_key().public_key(), tok)["reason"] == "bad signature"


def test_extension_fixture_matches_python():
    """chrome-extension/tests/licence-fixture.json was signed by this Python code;
    the JS tests verify the same keys, proving both sides agree."""
    fx = json.loads((Path(__file__).parent.parent / "chrome-extension/tests/licence-fixture.json").read_text())
    from cryptography.hazmat.primitives.asymmetric import ec
    import base64
    b = lambda s: int.from_bytes(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)), "big")
    pub = ec.EllipticCurvePublicNumbers(b(fx["jwk"]["x"]), b(fx["jwk"]["y"]), ec.SECP256R1()).public_key()
    assert verify_licence(pub, fx["valid"], now=fx["now"])["ok"]
    assert verify_licence(pub, fx["expired"], now=fx["now"])["reason"] == "expired"
