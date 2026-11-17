"""Tests for the texts GitHub Actions uploads to the Cloudflare Worker bot."""
from scrapers.fpl import fetch_manager_team
from stars_bot.analysis import Analyzer
from stars_bot.messages import esc
from stars_bot.publish import build_payload


def analyzer(fpl_data):
    return Analyzer(fetch=lambda horizon: fpl_data, fetch_team=fetch_manager_team)


def test_payload_has_texts_and_gameweek(fpl_data, mock_api):
    payload, errors = build_payload(analyzer(fpl_data), [123])
    assert errors == []
    assert payload["gameweek"]["next_gw"] and payload["gameweek"]["next_deadline"]
    assert "captain:" in payload["captain_text"]
    assert "Test FC" in payload["teams"]["123"] and "Captain:" in payload["teams"]["123"]


def test_bad_team_does_not_stop_others(fpl_data, mock_api):
    a = analyzer(fpl_data)
    real = a._fetch_team
    a._fetch_team = lambda tid: (_ for _ in ()).throw(RuntimeError("404")) if tid == 999 else real(tid)
    payload, errors = build_payload(a, [999, 123])
    assert list(payload["teams"]) == ["123"] and "team 999" in errors[0]


def test_html_is_escaped():
    assert esc("<b>&") == "&lt;b&gt;&amp;"


def test_admin_token_matches_worker(monkeypatch):
    from stars_bot.publish import admin_token
    monkeypatch.delenv("BOT_ADMIN_TOKEN", raising=False)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    # same value the Worker test expects (worker/test/worker.test.mjs)
    import hashlib
    assert admin_token() == hashlib.sha256(b"fpl-ai-admin:123:abc").hexdigest()
