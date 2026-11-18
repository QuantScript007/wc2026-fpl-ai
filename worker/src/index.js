// FPL AI Telegram bot on Cloudflare Workers (free plan).
//
// * Telegram webhook -> commands, Telegram Stars invoices, payments, licence keys
// * GitHub Actions uploads the FPL analysis every hour (POST /internal/publish);
//   the Worker only relays those texts, so each request stays far under 10 ms CPU
// * Cron every 5 minutes -> Premium deadline alerts and renewal reminders
//
// Stars rules (https://core.telegram.org/bots/payments-stars): currency "XTR", no
// provider token, answer pre_checkout_query within 10 s, support /paysupport and terms.
import { extensionConfig, generateKeyPair, publicOf, signLicence } from "./licence.js";

const DAY = 86400;
const PAYLOAD = "premium";              // invoice payload: premium:<days>:<user id>
const ALERT_WINDOWS_H = [2, 24];        // deadline alerts this many hours before
const RENEW_REMINDER_DAYS = 3;
const MAX_SENDS_PER_RUN = 40;           // free plan allows 50 outgoing requests per run

const now = () => Math.floor(Date.now() / 1000);
export const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtDate = ts => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function config(env) {
  return {
    price: Number(env.STARS_PRICE || 150),
    days: Number(env.PREMIUM_DAYS || 30),
    admins: new Set(String(env.ADMIN_IDS || "").match(/\d+/g)?.map(Number) || []),
    support: env.SUPPORT_CONTACT || "",
    extensionUrl: env.EXTENSION_URL || "",
  };
}

// ---------------------------------------------------------------- Telegram --
export async function tg(env, method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

async function safeSend(env, chat, text) {
  try { await send(env, chat, text); return true; } catch (e) { console.warn("send failed", chat, e.message); return false; }
}

// --------------------------------------------------------------------- D1 --
const db = env => env.DB;
const one = (env, sql, ...a) => db(env).prepare(sql).bind(...a).first();
const all = async (env, sql, ...a) => (await db(env).prepare(sql).bind(...a).all()).results;
const run = (env, sql, ...a) => db(env).prepare(sql).bind(...a).run();

export async function kvGet(env, key, json = true) {
  const row = await one(env, "SELECT value FROM kv WHERE key=?", key);
  return row ? (json ? JSON.parse(row.value) : row.value) : null;
}
const kvSet = (env, key, value) =>
  run(env, "INSERT INTO kv (key, value, updated) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated",
    key, typeof value === "string" ? value : JSON.stringify(value), now());

const touchUser = (env, uid, chat, name) =>
  run(env, "INSERT INTO users (user_id, chat_id, first_name, created) VALUES (?,?,?,?) " +
    "ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, first_name=excluded.first_name", uid, chat, name || "", now());
const getUser = (env, uid) => one(env, "SELECT * FROM users WHERE user_id=?", uid);
const premiumUntil = async (env, uid) => (await getUser(env, uid))?.premium_until || 0;
const isPremium = async (env, uid) => (await premiumUntil(env, uid)) > now();

/** Remember an alert; false if it was already sent. */
const markSent = async (env, key) =>
  (await run(env, "INSERT OR IGNORE INTO sent (key, created) VALUES (?,?)", key, now())).meta.changes === 1;

/** Store a payment and extend Premium; null if Telegram resent the same payment. */
export async function recordPayment(env, chargeId, uid, amount, payload, days) {
  const ins = await run(env, "INSERT OR IGNORE INTO payments (charge_id, user_id, amount, payload, days, created) VALUES (?,?,?,?,?,?)",
    chargeId, uid, amount, payload, days, now());
  if (ins.meta.changes === 0) return null;
  const until = Math.max(now(), await premiumUntil(env, uid)) + days * DAY;
  await run(env, "UPDATE users SET premium_until=? WHERE user_id=?", until, uid);
  return until;
}

async function markRefunded(env, chargeId) {
  const p = await one(env, "SELECT * FROM payments WHERE charge_id=?", chargeId);
  if (!p || p.refunded) return null;
  await run(env, "UPDATE payments SET refunded=1 WHERE charge_id=?", chargeId);
  const until = Math.max(now(), (await premiumUntil(env, p.user_id)) - p.days * DAY);
  await run(env, "UPDATE users SET premium_until=? WHERE user_id=?", until, p.user_id);
  return p;
}

// ------------------------------------------------------------ licence key --
async function privateKey(env) {
  const jwk = await kvGet(env, "licence_private_jwk");
  if (!jwk) throw new Error("Licence key not set up yet — run the Deploy bot workflow.");
  return jwk;
}

async function sendKey(env, uid, chat) {
  const until = await premiumUntil(env, uid);
  const key = await signLicence(await privateKey(env), uid, until);
  await send(env, chat, `🔑 <b>Your Chrome extension key</b> (valid until ${fmtDate(until)}):\n\n<code>${esc(key)}</code>\n\n` +
    "Open the extension → Dashboard → Settings → Premium, paste the key and press <b>Activate</b>. " +
    "After you renew, send /key for a new one.");
}

// Optional: ask GitHub Actions to analyse a newly added team right away.
async function requestPublish(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  try {
    await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/fpl-bot-data.yml/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "fpl-ai-bot" },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main" }),
    });
  } catch (e) { console.warn("dispatch failed", e.message); }
}

// --------------------------------------------------------------- commands --
const upsell = (env, chat, why) => {
  const c = config(env);
  return send(env, chat, `🔒 ${esc(why)}\nGet Premium: ⭐${c.price} for ${c.days} days — /premium`);
};

const commands = {
  async start(env, uid, chat, args) {
    if (args[0] === "premium") return commands.premium(env, uid, chat, []);
    const c = config(env);
    return send(env, chat,
      "⚽ <b>FPL AI</b> — expected points, captain picks and transfer advice.\n\n" +
      "<b>Free</b>\n/captain — best captain this gameweek\n/differentials — low-owned picks\n" +
      "/team &lt;id&gt; — save your FPL team ID\n\n" +
      `<b>Premium</b> — ⭐${c.price} for ${c.days} days\n` +
      "• /myteam — captain, lineup and transfers for your team\n" +
      "• Deadline alerts here 24h and 2h before every deadline\n" +
      "• Unlocks the Chrome extension: apply changes + autopilot, FPL Draft tab, transfer planner\n\n" +
      "/premium — buy · /status — your plan · /key — extension key\n/terms · /paysupport" +
      (c.extensionUrl ? `\n\nChrome extension: ${esc(c.extensionUrl)}` : ""));
  },
  async captain(env, uid, chat) {
    return send(env, chat, (await kvGet(env, "captain_text", false)) || "Picks are being prepared — try again in a few minutes.");
  },
  async differentials(env, uid, chat) {
    return send(env, chat, (await kvGet(env, "differentials_text", false)) || "Picks are being prepared — try again in a few minutes.");
  },
  async team(env, uid, chat, args) {
    if (!/^\d{1,9}$/.test(args[0] || ""))
      return send(env, chat, "Send <code>/team 123456</code>. Your team ID is in the URL of your FPL Points page: " +
        "fantasy.premierleague.com/entry/<b>123456</b>/event/…");
    await run(env, "UPDATE users SET team_id=? WHERE user_id=?", Number(args[0]), uid);
    const premium = await isPremium(env, uid);
    if (premium) await requestPublish(env);
    return send(env, chat, `✅ Team ${esc(args[0])} saved.` +
      (premium ? " Your team report will be ready within the hour — /myteam." : " Get /premium for team advice and deadline alerts."));
  },
  async myteam(env, uid, chat) {
    if (!(await isPremium(env, uid))) return upsell(env, chat, "Team advice is a Premium feature.");
    const u = await getUser(env, uid);
    if (!u.team_id) return send(env, chat, "First send <code>/team 123456</code> with your FPL team ID.");
    const r = await one(env, "SELECT text, updated FROM team_reports WHERE team_id=?", u.team_id);
    if (!r) return send(env, chat, "Your first team report is being prepared — it's usually ready within the hour.");
    const mins = Math.round((now() - r.updated) / 60);
    return send(env, chat, `${r.text}\n\n<i>Updated ${mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`} ago.</i>`);
  },
  async premium(env, uid, chat) {
    const c = config(env), until = await premiumUntil(env, uid);
    const note = until > now() ? ` Adds ${c.days} days to your current plan (ends ${fmtDate(until)}).` : "";
    return tg(env, "sendInvoice", {
      chat_id: chat,
      title: `FPL AI Premium — ${c.days} days`,
      description: ("Team advice and deadline alerts in Telegram, plus a key that unlocks the Chrome extension's " +
        "apply/autopilot, FPL Draft tab and transfer planner." + note).slice(0, 255),
      payload: `${PAYLOAD}:${c.days}:${uid}`,
      currency: "XTR",
      prices: [{ label: `Premium ${c.days} days`, amount: c.price }],
    });
  },
  async key(env, uid, chat) {
    if (!(await isPremium(env, uid))) return upsell(env, chat, "You don't have Premium yet.");
    return sendKey(env, uid, chat);
  },
  async status(env, uid, chat) {
    const c = config(env), u = await getUser(env, uid);
    const text = u.premium_until > now()
      ? `⭐ Premium until <b>${fmtDate(u.premium_until)}</b>. /premium adds ${c.days} more days.`
      : "Free plan. /premium to upgrade.";
    return send(env, chat, `${text}\nFPL team: ${u.team_id ? esc(u.team_id) : "not set — /team 123456"}`);
  },
  async terms(env, uid, chat) {
    const c = config(env);
    return send(env, chat, "<b>Terms</b>\n" +
      `• Premium costs ⭐${c.price} Telegram Stars for ${c.days} days and does not renew automatically. Buying again adds days.\n` +
      "• FPL AI gives estimates, not guarantees. You decide every change to your team; the extension only saves changes " +
      "you confirm or turn on (autopilot).\n" +
      "• FPL AI is not affiliated with the Premier League or Fantasy Premier League.\n" +
      "• Refunds: within 7 days of purchase if Premium didn't work for you — use /paysupport.\n" +
      "• We store your Telegram ID, FPL team ID and payment records only to provide the service.");
  },
  async paysupport(env, uid, chat, args, raw) {
    const last = await one(env, "SELECT charge_id FROM payments WHERE user_id=? AND refunded=0 ORDER BY created DESC LIMIT 1", uid);
    const ref = last ? `\nPayment ID: <code>${esc(last.charge_id)}</code>` : "";
    const msg = raw.replace(/^\/\S+\s*/, "");
    if (msg) {
      for (const a of config(env).admins) await safeSend(env, a, `💬 /paysupport from <code>${uid}</code>:\n${esc(msg)}${ref}`);
      return send(env, chat, "Thanks — we got your message and will reply here soon.");
    }
    const c = config(env);
    return send(env, chat, `💬 Payment help: ${c.support ? `message ${esc(c.support)} or ` : ""}send <code>/paysupport</code> ` +
      `followed by what went wrong. We'll sort it out, including refunds (see /terms).${ref}`);
  },
  // ---- admin only ----
  async refund(env, uid, chat, args) {
    if (!args[0]) return send(env, chat, "Usage: <code>/refund &lt;payment ID&gt;</code>");
    const p = await one(env, "SELECT * FROM payments WHERE charge_id=?", args[0]);
    if (!p) return send(env, chat, "No such payment.");
    if (p.refunded) return send(env, chat, "Already refunded.");
    await tg(env, "refundStarTransaction", { user_id: p.user_id, telegram_payment_charge_id: p.charge_id });
    await markRefunded(env, p.charge_id);
    await send(env, chat, `Refunded ⭐${p.amount} to user ${p.user_id}.`);
    const u = await getUser(env, p.user_id);
    if (u) await safeSend(env, u.chat_id, `↩️ Your payment of ⭐${p.amount} was refunded and your Premium was shortened. ` +
      "Extension keys already issued stop working when they expire.");
  },
  async reply(env, uid, chat, args, raw) {
    const target = /^\d+$/.test(args[0] || "") && await getUser(env, Number(args[0]));
    const msg = raw.replace(/^\/\S+\s+\S+\s*/, "");
    if (!target || !msg) return send(env, chat, "Usage: <code>/reply &lt;user ID&gt; &lt;message&gt;</code>");
    await send(env, target.chat_id, `💬 Support: ${esc(msg)}`);
    return send(env, chat, "Sent.");
  },
  async stats(env, uid, chat) {
    const u = await one(env, "SELECT COUNT(*) n, SUM(premium_until > ?) p FROM users", now());
    const pay = await one(env, "SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments WHERE refunded=0");
    return send(env, chat, `Users: ${u.n} · Premium now: ${u.p || 0}\nPayments: ${pay.n} · ⭐${pay.s} total`);
  },
};
const ADMIN_COMMANDS = new Set(["refund", "reply", "stats"]);
const ALIASES = { help: "start", buy: "premium" };

// ---------------------------------------------------------------- updates --
/** Handle one Telegram update. May return a method object to answer inside the webhook response. */
export async function handleUpdate(env, update) {
  if (update.pre_checkout_query) return preCheckout(env, update.pre_checkout_query);
  const msg = update.message;
  const user = msg?.from;
  if (!user?.id) return null;
  const chat = msg.chat.id;
  await touchUser(env, user.id, chat, user.first_name);

  if (msg.successful_payment) return onPaid(env, user.id, chat, msg.successful_payment);
  if (msg.refunded_payment?.telegram_payment_charge_id) {
    await markRefunded(env, msg.refunded_payment.telegram_payment_charge_id);
    return null;
  }
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) { await send(env, chat, "Send /help to see what I can do."); return null; }
  const [cmdRaw, ...args] = text.split(/\s+/);
  let cmd = cmdRaw.slice(1).split("@")[0].toLowerCase();
  cmd = ALIASES[cmd] || cmd;
  const handler = Object.hasOwn(commands, cmd) && (!ADMIN_COMMANDS.has(cmd) || config(env).admins.has(user.id)) && commands[cmd];
  if (handler) await handler(env, user.id, chat, args, text);
  else await send(env, chat, "Unknown command. Send /help.");
  return null;
}

export function preCheckout(env, q) {
  const c = config(env), parts = String(q.invoice_payload || "").split(":");
  const ok = parts.length === 3 && parts[0] === PAYLOAD && parts[1] === String(c.days) &&
    parts[2] === String(q.from?.id) && q.currency === "XTR" && q.total_amount === c.price;
  // Answered inside the webhook response: no extra request, well within Telegram's 10 seconds.
  return { method: "answerPreCheckoutQuery", pre_checkout_query_id: q.id, ok,
    ...(ok ? {} : { error_message: "This offer has changed — send /premium for a new invoice." }) };
}

async function onPaid(env, uid, chat, sp) {
  const parts = String(sp.invoice_payload || "").split(":");
  const days = parts.length === 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : config(env).days;
  const until = await recordPayment(env, sp.telegram_payment_charge_id, uid, sp.total_amount || 0, sp.invoice_payload || "", days);
  if (until === null) return null;  // duplicate
  console.log(`payment ${sp.telegram_payment_charge_id} from ${uid}: ${sp.total_amount} Stars`);
  await send(env, chat, `⭐ Thanks! Premium is active until <b>${fmtDate(until)}</b>.`);
  await sendKey(env, uid, chat);
  const u = await getUser(env, uid);
  if (!u.team_id) await send(env, chat, "Send <code>/team 123456</code> with your FPL team ID to get deadline alerts.");
  else await requestPublish(env);
  return null;
}

// ----------------------------------------------------------------- alerts --
export async function runAlerts(env, t = now()) {
  let sent = 0;
  const premium = await all(env, "SELECT u.*, r.text AS report FROM users u LEFT JOIN team_reports r ON r.team_id = u.team_id " +
    "WHERE u.premium_until > ? ORDER BY u.user_id", t);

  for (const u of premium) {
    if (sent >= MAX_SENDS_PER_RUN) return sent;
    if (u.premium_until - t < RENEW_REMINDER_DAYS * DAY && await markSent(env, `renew:${u.user_id}:${u.premium_until}`)) {
      await safeSend(env, u.chat_id, `⏳ Your Premium ends ${fmtDate(u.premium_until)}. /premium to add another month, ` +
        "then /key for a new extension key.");
      sent++;
    }
  }
  const gw = await kvGet(env, "gameweek");
  if (!gw?.next_deadline) return sent;
  const hours = (Date.parse(gw.next_deadline) / 1000 - t) / 3600;
  const window = ALERT_WINDOWS_H.find(w => hours > 0 && hours <= w);
  if (!window) return sent;
  const heading = hours >= 1 ? `⏰ <b>GW${gw.next_gw} deadline in ${Math.round(hours)}h</b>`
                             : `⏰ <b>GW${gw.next_gw} deadline in ${Math.round(hours * 60)} min</b>`;
  for (const u of premium) {
    if (sent >= MAX_SENDS_PER_RUN) break;  // the next run (5 min later) carries on
    if (!u.report || !(await markSent(env, `dl:${gw.next_gw}:${window}:${u.user_id}`))) continue;
    await safeSend(env, u.chat_id, `${heading}\n${u.report}`);
    sent++;
  }
  return sent;
}

// ------------------------------------------------------------ admin HTTP --
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function sha256hex(text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/** Token GitHub Actions uses for /internal/*: ADMIN_TOKEN, or derived from the bot token
 *  (same formula in stars_bot/publish.py) so there's one less secret to manage. */
export const adminToken = async env => env.ADMIN_TOKEN || (await sha256hex(`fpl-ai-admin:${env.TELEGRAM_BOT_TOKEN}`));
/** Secret Telegram puts in every webhook call. */
export const webhookSecret = async env => (await sha256hex(`webhook:${await adminToken(env)}`)).slice(0, 48);

async function authorized(req, env) {
  const expected = await adminToken(env);
  return expected.length >= 16 && (req.headers.get("authorization") || "") === `Bearer ${expected}`;
}

async function setup(env, origin) {
  let priv = await kvGet(env, "licence_private_jwk");
  if (!priv) {
    priv = (await generateKeyPair()).privateJwk;
    await kvSet(env, "licence_private_jwk", priv);
  }
  const c = config(env);
  const me = await tg(env, "getMe");
  await tg(env, "setWebhook", {
    url: `${origin}/telegram`, secret_token: await webhookSecret(env),
    allowed_updates: ["message", "pre_checkout_query"], max_connections: 20,
  });
  await tg(env, "setMyCommands", { commands: [
    ["captain", "Best captain this gameweek"], ["differentials", "Low-owned picks"], ["team", "Save your FPL team ID"],
    ["myteam", "Advice for your team (Premium)"], ["premium", `Get Premium — ⭐${c.price}`], ["status", "Your plan"],
    ["key", "Chrome extension key (Premium)"], ["terms", "Terms"], ["paysupport", "Payment help"],
  ].map(([command, description]) => ({ command, description })) });
  const pub = publicOf(priv);
  return { bot: me.username, webhook: `${origin}/telegram`, public_jwk: pub, licence_config_js: extensionConfig(pub, me.username) };
}

async function publish(env, body) {
  const stmts = [];
  const put = (k, v) => stmts.push(db(env).prepare(
    "INSERT INTO kv (key, value, updated) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated")
    .bind(k, typeof v === "string" ? v : JSON.stringify(v), now()));
  if (body.gameweek) put("gameweek", body.gameweek);
  if (body.captain_text) put("captain_text", body.captain_text);
  if (body.differentials_text) put("differentials_text", body.differentials_text);
  for (const [team, text] of Object.entries(body.teams || {})) {
    if (!/^\d+$/.test(team) || typeof text !== "string") continue;
    stmts.push(db(env).prepare("INSERT INTO team_reports (team_id, text, updated) VALUES (?,?,?) " +
      "ON CONFLICT(team_id) DO UPDATE SET text=excluded.text, updated=excluded.updated").bind(Number(team), text, now()));
  }
  if (stmts.length) await db(env).batch(stmts);
  return { saved: stmts.length };
}

// ---------------------------------------------------------------- entry --
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/telegram" && req.method === "POST") {
        if (req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret(env)) return new Response("forbidden", { status: 403 });
        const reply = await handleUpdate(env, await req.json());
        return reply ? json(reply) : new Response("ok");
      }
      if (url.pathname === "/public-key") {
        const priv = await kvGet(env, "licence_private_jwk");
        return priv ? json(publicOf(priv)) : json({ error: "not set up" }, 404);
      }
      if (url.pathname.startsWith("/internal/")) {
        if (!(await authorized(req, env))) return json({ error: "unauthorized" }, 401);
        if (url.pathname === "/internal/setup" && req.method === "POST") return json(await setup(env, url.origin));
        if (url.pathname === "/internal/teams")
          return json({ teams: (await all(env, "SELECT DISTINCT team_id FROM users WHERE premium_until > ? AND team_id IS NOT NULL", now()))
            .map(r => r.team_id) });
        if (url.pathname === "/internal/publish" && req.method === "POST") return json(await publish(env, await req.json()));
        if (url.pathname === "/internal/alerts" && req.method === "POST") return json({ sent: await runAlerts(env) });
        return json({ error: "not found" }, 404);
      }
      if (url.pathname === "/") return new Response("FPL AI bot is running.");
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e.stack || e.message);
      // Always 200 to Telegram so a bad update isn't retried forever.
      return url.pathname === "/telegram" ? new Response("ok") : json({ error: e.message }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env).catch(e => console.error("alerts", e.stack || e.message)));
  },
};
