"""Unit tests for notifications.telegram."""
import pytest, requests
from unittest.mock import MagicMock, patch


def _cfg(mp, token="tok", chat="123"):
    import notifications.telegram as tg
    mp.setattr(tg,"_BOT_TOKEN",token); mp.setattr(tg,"_CHAT_ID",chat)


def _ok_post(): return patch("notifications.telegram.requests.post",
                             return_value=MagicMock(raise_for_status=MagicMock()))


class TestSend:
    def test_returns_true(self, monkeypatch):
        _cfg(monkeypatch)
        with _ok_post():
            from notifications.telegram import send
            assert send("hello") is True

    def test_correct_url(self, monkeypatch):
        _cfg(monkeypatch, token="mytoken")
        with patch("notifications.telegram.requests.post") as mp:
            mp.return_value.raise_for_status = MagicMock()
            from notifications.telegram import send; send("x")
        assert "mytoken" in mp.call_args[0][0] and "sendMessage" in mp.call_args[0][0]

    def test_payload(self, monkeypatch):
        _cfg(monkeypatch, chat="99999")
        with patch("notifications.telegram.requests.post") as mp:
            mp.return_value.raise_for_status = MagicMock()
            from notifications.telegram import send; send("msg")
        d = mp.call_args[1]["data"]
        assert d["text"]=="msg" and d["chat_id"]=="99999"

    def test_false_when_no_token(self, monkeypatch):
        _cfg(monkeypatch, token="")
        from notifications.telegram import send
        assert send("x") is False

    def test_false_when_no_chat(self, monkeypatch):
        _cfg(monkeypatch, chat="")
        from notifications.telegram import send
        assert send("x") is False

    def test_no_call_when_unconfigured(self, monkeypatch):
        _cfg(monkeypatch, token="", chat="")
        with patch("notifications.telegram.requests.post") as mp:
            from notifications.telegram import send; send("x")
        mp.assert_not_called()

    def test_http_error_propagates(self, monkeypatch):
        _cfg(monkeypatch)
        with patch("notifications.telegram.requests.post") as mp:
            mp.return_value.raise_for_status.side_effect = requests.HTTPError("429")
            from notifications.telegram import send
            with pytest.raises(requests.HTTPError): send("x")

    def test_default_parse_mode(self, monkeypatch):
        _cfg(monkeypatch)
        with patch("notifications.telegram.requests.post") as mp:
            mp.return_value.raise_for_status = MagicMock()
            from notifications.telegram import send; send("x")
        assert mp.call_args[1]["data"]["parse_mode"] == "HTML"

    def test_timeout_set(self, monkeypatch):
        _cfg(monkeypatch)
        with patch("notifications.telegram.requests.post") as mp:
            mp.return_value.raise_for_status = MagicMock()
            from notifications.telegram import send; send("x")
        assert "timeout" in mp.call_args[1] and mp.call_args[1]["timeout"] > 0
