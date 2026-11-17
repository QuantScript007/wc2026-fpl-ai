// FPL AI Premium: checks the licence key the Telegram bot sends after a Stars payment.
//
// Key format: FPLAI1.<payload>.<signature> (base64url). The payload is
// {"u": telegram user id, "exp": unix seconds, "iat": unix seconds}; the signature is
// ECDSA P-256 / SHA-256 over "FPLAI1.<payload>", made with the bot's private key.
// Only the public key ships here, so keys are checked offline — no server.
import { BOT_USERNAME, LICENCE_PUBLIC_KEY } from "./licence-config.js";

const PREFIX = "FPLAI1";
const enc = new TextEncoder();

const unb64 = s => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

/** Verify a key. Returns {ok, user, exp, reason}. Pure: no chrome.* calls (unit-tested in Node). */
export async function verifyLicence(token, publicJwk = LICENCE_PUBLIC_KEY, now = Date.now() / 1000) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "That isn't an FPL AI key." };
  let payload;
  try {
    const key = await crypto.subtle.importKey("jwk", { ...publicJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!good) return { ok: false, reason: "This key isn't valid." };
    payload = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
  } catch {
    return { ok: false, reason: "This key isn't valid." };
  }
  if (!(payload.exp > now)) return { ok: false, reason: "This key has expired — send /key to the bot after renewing.", user: payload.u, exp: payload.exp };
  return { ok: true, user: payload.u, exp: payload.exp };
}

export const premiumLink = () => BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=premium` : "";

/** Current Premium state for the UI and background worker. */
export async function getPremium() {
  if (!LICENCE_PUBLIC_KEY) return { premium: true, configured: false };
  const { licenceKey } = await chrome.storage.local.get("licenceKey");
  if (!licenceKey) return { premium: false, configured: true };
  const v = await verifyLicence(licenceKey);
  return { premium: v.ok, configured: true, exp: v.exp, user: v.user, reason: v.ok ? null : v.reason };
}

/** Check and store a key the user pasted. Throws with a readable message if it's no good. */
export async function activateLicence(token) {
  token = String(token || "").replace(/\s+/g, "");
  const v = await verifyLicence(token);
  if (!v.ok) throw new Error(v.reason);
  await chrome.storage.local.set({ licenceKey: token });
  return v;
}

export async function removeLicence() {
  await chrome.storage.local.remove("licenceKey");
}

export class PremiumError extends Error {
  constructor() { super("That's a Premium feature — get Premium in Telegram, then paste your key in Settings."); }
}

export async function requirePremium() {
  if (!(await getPremium()).premium) throw new PremiumError();
}
