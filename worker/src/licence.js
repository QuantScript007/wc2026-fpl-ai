// Premium licence keys, signed here and verified offline by the Chrome extension
// (chrome-extension/lib/licence.js). Format: FPLAI1.<payload>.<signature>, base64url;
// payload {"u": telegram id, "exp": unix s, "iat": unix s}; ECDSA P-256 / SHA-256,
// raw r||s signature over "FPLAI1.<payload>".
const PREFIX = "FPLAI1";
const ALG = { name: "ECDSA", namedCurve: "P-256" };
const enc = new TextEncoder();

export const b64url = bytes => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** New key pair as JWKs. */
export async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const { kty, crv, x, y } = priv;
  return { privateJwk: { kty, crv, x, y, d: priv.d }, publicJwk: { kty, crv, x, y } };
}

export const publicOf = ({ kty, crv, x, y }) => ({ kty, crv, x, y });

export async function signLicence(privateJwk, userId, exp, iat = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, ext: true }, ALG, false, ["sign"]);
  const body = `${PREFIX}.${b64url(enc.encode(JSON.stringify({ u: userId, exp, iat })))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/** The extension's licence-config.js for this public key. */
export const extensionConfig = (publicJwk, botUsername) =>
  "// Written by the Deploy bot workflow. Public key only -- safe to publish.\n" +
  "// null = licensing not set up yet, so every feature stays unlocked.\n" +
  `export const LICENCE_PUBLIC_KEY = { kty: "EC", crv: "P-256", x: "${publicJwk.x}", y: "${publicJwk.y}" };\n` +
  `export const BOT_USERNAME = "${botUsername}";\n`;
