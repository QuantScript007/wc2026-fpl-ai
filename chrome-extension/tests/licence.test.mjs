// Premium licence keys: the extension must accept exactly the keys the Telegram bot signs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyLicence } from "../lib/licence.js";

// Signed by stars_bot/licence.py (Python) with a throwaway key.
const fx = JSON.parse(fs.readFileSync(new URL("./licence-fixture.json", import.meta.url)));

test("accepts a key signed by the Python bot", async () => {
  const v = await verifyLicence(fx.valid, fx.jwk, fx.now);
  assert.equal(v.ok, true);
  assert.equal(v.user, 424242);
  assert.ok(v.exp > fx.now);
});

test("rejects an expired key", async () => {
  const v = await verifyLicence(fx.expired, fx.jwk, fx.now);
  assert.equal(v.ok, false);
  assert.match(v.reason, /expired/);
});

test("rejects a tampered payload (e.g. a later expiry)", async () => {
  const [h, p, s] = fx.valid.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  payload.exp += 365 * 86400;
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
  assert.equal((await verifyLicence(forged, fx.jwk, fx.now)).ok, false);
});

test("rejects a key from a different signer", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const otherJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  assert.equal((await verifyLicence(fx.valid, { kty: "EC", crv: "P-256", x: otherJwk.x, y: otherJwk.y }, fx.now)).ok, false);
});

test("rejects junk", async () => {
  for (const junk of ["", "hello", "FPLAI1.a.b", "XX.a.b", null])
    assert.equal((await verifyLicence(junk, fx.jwk, fx.now)).ok, false);
});
