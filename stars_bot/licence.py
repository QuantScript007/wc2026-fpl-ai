"""Signed Premium licence keys that the Chrome extension can check offline.

A key looks like ``FPLAI1.<payload>.<signature>`` (both parts base64url):

* payload  -- JSON ``{"u": telegram_user_id, "exp": unix_seconds, "iat": unix_seconds}``
* signature -- ECDSA P-256 / SHA-256 over the ASCII text ``FPLAI1.<payload>``,
  in the raw 64-byte r||s form that WebCrypto's ``verify`` expects.

The bot keeps the private key; the extension only ships the public key, so it
can verify keys without a server.
"""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

PREFIX = "FPLAI1"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def generate_private_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def save_private_key(key: ec.EllipticCurvePrivateKey, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                       serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def load_private_key(path: Path) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("Licence key must be an EC P-256 private key")
    return key


def public_jwk(key) -> dict:
    """The public half as a JWK (what the extension imports with WebCrypto)."""
    pub = key.public_key() if hasattr(key, "public_key") else key
    nums = pub.public_numbers()
    return {"kty": "EC", "crv": "P-256",
            "x": _b64(nums.x.to_bytes(32, "big")), "y": _b64(nums.y.to_bytes(32, "big"))}


def sign_licence(key: ec.EllipticCurvePrivateKey, user_id: int, expires: int,
                 issued: int | None = None) -> str:
    payload = {"u": int(user_id), "exp": int(expires), "iat": int(issued or time.time())}
    body = f"{PREFIX}.{_b64(json.dumps(payload, separators=(',', ':')).encode())}"
    r, s = decode_dss_signature(key.sign(body.encode(), ec.ECDSA(hashes.SHA256())))
    return f"{body}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def verify_licence(public_key, token: str, now: float | None = None) -> dict:
    """Mirror of the extension's check (used by tests and /status)."""
    try:
        prefix, payload_b64, sig_b64 = token.strip().split(".")
        if prefix != PREFIX:
            return {"ok": False, "reason": "not an FPL AI key"}
        sig = _unb64(sig_b64)
        if len(sig) != 64:
            return {"ok": False, "reason": "bad signature"}
        der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
        public_key.verify(der, f"{prefix}.{payload_b64}".encode(), ec.ECDSA(hashes.SHA256()))
        payload = json.loads(_unb64(payload_b64))
    except InvalidSignature:
        return {"ok": False, "reason": "bad signature"}
    except Exception:
        return {"ok": False, "reason": "malformed key"}
    if payload.get("exp", 0) <= (now if now is not None else time.time()):
        return {"ok": False, "reason": "expired", "user": payload.get("u"), "exp": payload.get("exp")}
    return {"ok": True, "user": payload["u"], "exp": payload["exp"]}
