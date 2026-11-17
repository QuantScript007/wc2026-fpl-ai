// Worker tests: Stars invoices, pre-checkout, payments, licence keys, publishing, alerts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { adminToken, handleUpdate, runAlerts, webhookSecret } from "../src/index.js";
import { verifyLicence } from "../../chrome-extension/lib/licence.js";
import { makeD1 } from "./d1-shim.mjs";

const UID = 1001, CHAT = 5001, ADMIN = 9009, TOKEN = "admin-token-0123456789";
let env, calls;

beforeEach(() => {
  env = { DB: makeD1(), TELEGRAM_BOT_TOKEN: "123:abc", ADMIN_TOKEN: TOKEN, ADMIN_IDS: String(ADMIN), STARS_PRICE: "150", PREMIUM_DAYS: "30" };
  calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : {} });
    const result = method === "getMe" ? { username: "FplAiDemoBot" } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
});

const texts = (chat = CHAT) => calls.filter(c => c.method === "sendMessage" && c.body.chat_id === chat).map(c => c.body.text);
const last = m => calls.filter(c => c.method === m).at(-1)?.body;
const msg = (text, uid = UID, extra = {}) => ({ update_id: 1, message: { message_id: 1, from: { id: uid, first_name: "Ana" },
  chat: { id: uid === UID ? CHAT : uid }, ...(text !== null ? { text } : {}), ...extra } });
const pay = (charge = "ch_1", amount = 150) => handleUpdate(env, msg(null, UID, { successful_payment: {
  currency: "XTR", total_amount: amount, invoice_payload: `premium:30:${UID}`, telegram_payment_charge_id: charge } }));

async function post(path, body, auth = true) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  const res = await worker.fetch(new Request(`https://bot.example.workers.dev${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env, {});
  return { status: res.status, body: await res.json().catch(() => null) };
}
const setup = () => post("/internal/setup", {});

test("setup creates a key, sets the webhook and returns the extension config", async () => {
  const r = await setup();
  assert.equal(r.status, 200);
  assert.equal(r.body.bot, "FplAiDemoBot");
  assert.equal(last("setWebhook").url, "https://bot.example.workers.dev/telegram");
  assert.equal(last("setWebhook").secret_token, await webhookSecret(env));
  assert.match(r.body.licence_config_js, /LICENCE_PUBLIC_KEY = \{ kty: "EC"/);
  assert.equal(r.body.public_jwk.d, undefined, "private part must never leave");
  const again = await setup();
  assert.deepEqual(again.body.public_jwk, r.body.public_jwk, "setup is repeatable without changing the key");
});

test("admin token can be derived from the bot token (matches publish.py)", async () => {
  delete env.ADMIN_TOKEN;
  // python: hashlib.sha256(b"fpl-ai-admin:123:abc").hexdigest()
  assert.equal(await adminToken(env), "aa08c6f231bc8dfc03871141a424600fbb4cfe61242bdfa1dce81d6ae19bce7e");
});

test("internal endpoints need the admin token", async () => {
  assert.equal((await post("/internal/setup", {}, false)).status, 401);
  assert.equal((await post("/internal/publish", {}, false)).status, 401);
});

test("webhook rejects calls without Telegram's secret header", async () => {
  const res = await worker.fetch(new Request("https://x.dev/telegram", { method: "POST", body: "{}" }), env, {});
  assert.equal(res.status, 403);
});

test("/premium sends a Stars invoice", async () => {
  await handleUpdate(env, msg("/premium"));
  const inv = last("sendInvoice");
  assert.equal(inv.currency, "XTR");
  assert.deepEqual(inv.prices, [{ label: "Premium 30 days", amount: 150 }]);
  assert.equal(inv.payload, `premium:30:${UID}`);
  assert.equal(inv.provider_token, undefined);
});

test("/start premium deep link opens the invoice", async () => {
  await handleUpdate(env, msg("/start premium"));
  assert.equal(last("sendInvoice").currency, "XTR");
});

test("pre-checkout is answered inside the webhook response", async () => {
  await setup();
  const q = { id: "q1", from: { id: UID }, currency: "XTR", total_amount: 150, invoice_payload: `premium:30:${UID}` };
  const res = await worker.fetch(new Request("https://x.dev/telegram", { method: "POST",
    headers: { "x-telegram-bot-api-secret-token": await webhookSecret(env) }, body: JSON.stringify({ update_id: 3, pre_checkout_query: q }) }), env, {});
  assert.deepEqual(await res.json(), { method: "answerPreCheckoutQuery", pre_checkout_query_id: "q1", ok: true });
  for (const bad of [{ total_amount: 1 }, { currency: "USD" }, { invoice_payload: "premium:30:42" }, { invoice_payload: "junk" }]) {
    const r = await handleUpdate(env, { pre_checkout_query: { ...q, ...bad } });
    assert.equal(r.ok, false); assert.ok(r.error_message);
  }
});

test("payment grants Premium and sends a key the extension accepts", async () => {
  const { body } = await setup();
  await handleUpdate(env, msg("/start"));
  await pay();
  const keyMsg = texts().find(t => t.includes("Chrome extension key"));
  const token = keyMsg.split("<code>")[1].split("</code>")[0];
  const v = await verifyLicence(token, body.public_jwk);
  assert.equal(v.ok, true);
  assert.equal(v.user, UID);
  assert.ok(v.exp > Date.now() / 1000 + 29 * 86400);
});

test("duplicate payment updates are ignored; a second payment extends", async () => {
  await setup(); await handleUpdate(env, msg("/start"));
  await pay("a");
  const first = env.DB.sqlite.prepare("SELECT premium_until p FROM users").get().p;
  await pay("a");
  assert.equal(env.DB.sqlite.prepare("SELECT premium_until p FROM users").get().p, first);
  await pay("b");
  assert.equal(env.DB.sqlite.prepare("SELECT premium_until p FROM users").get().p, first + 30 * 86400);
});

test("Premium commands are locked for free users", async () => {
  await handleUpdate(env, msg("/myteam"));
  await handleUpdate(env, msg("/key"));
  assert.ok(texts().every(t => t.includes("Premium")));
});

test("published texts are relayed; /myteam shows the team report", async () => {
  await setup(); await handleUpdate(env, msg("/start"));
  await pay();
  await handleUpdate(env, msg("/team 123"));
  assert.deepEqual((await post("/internal/teams", {})).body, { teams: [123] });
  await post("/internal/publish", { gameweek: { next_gw: 7, next_deadline: "2030-01-01T10:00:00Z" },
    captain_text: "<b>GW7 captain:</b> Salah", differentials_text: "diffs", teams: { 123: "<b>Test FC</b> report" } });
  await handleUpdate(env, msg("/captain"));
  await handleUpdate(env, msg("/myteam"));
  const t = texts();
  assert.ok(t.includes("<b>GW7 captain:</b> Salah"));
  assert.match(t.at(-1), /Test FC/);
});

test("admin refund calls refundStarTransaction and removes Premium", async () => {
  await setup(); await handleUpdate(env, msg("/start"));
  await pay("ch_9");
  await handleUpdate(env, msg("/refund ch_9")); // not admin -> ignored
  assert.equal(last("refundStarTransaction"), undefined);
  await handleUpdate(env, msg("/refund ch_9", ADMIN));
  assert.deepEqual(last("refundStarTransaction"), { user_id: UID, telegram_payment_charge_id: "ch_9" });
  await handleUpdate(env, msg("/status"));
  assert.match(texts().at(-1), /Free plan/);
});

test("/terms and /paysupport exist; support messages reach admins", async () => {
  await handleUpdate(env, msg("/terms"));
  await handleUpdate(env, msg("/paysupport my key does not work"));
  assert.ok(texts().some(t => t.includes("Terms")));
  assert.ok(texts(ADMIN).some(t => t.includes("my key does not work")));
});

test("deadline alerts: once per window, Premium users with a report only", async () => {
  await setup(); await handleUpdate(env, msg("/start"));
  await handleUpdate(env, msg("/start", 2002));            // free user
  await handleUpdate(env, msg("/team 456", 2002));
  await pay();
  await handleUpdate(env, msg("/team 123"));
  const deadline = Math.floor(Date.now() / 1000) + 5 * 86400;
  await post("/internal/publish", { gameweek: { next_gw: 7, next_deadline: new Date(deadline * 1000).toISOString() },
    teams: { 123: "my report", 456: "other" } });
  const alerts = () => calls.filter(c => c.method === "sendMessage" && /deadline in/.test(c.body.text));
  await runAlerts(env, deadline - 20 * 3600);
  await runAlerts(env, deadline - 20 * 3600 + 300);
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].body.chat_id, CHAT);
  await runAlerts(env, deadline - 3600);
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].body.text, /deadline in 1h/);
});
