// Chubby's guest feedback: everything the pages talk to lives in this one file.
// Cloudflare runs it for any address that starts with /api/.
//
// Settings it reads from the Cloudflare project (Settings > Variables and Secrets / Bindings):
//   DB                    the D1 database (binding)
//   STAFF_PIN             PIN staff type to redeem coupons and resolve complaints
//   CHAT_WEBHOOK_ALERTS   Google Chat webhook link for new low ratings
//   CHAT_WEBHOOK_FOLLOWUP Google Chat webhook link for complaints still open after 24 hours
//   CRON_KEY              password the hourly check uses (see .github/workflows/followup.yml)
//   MANAGER_PASSWORD      password for the results page (/results), for the owner and manager

// ---- Stores. Add a store here to give it its own survey link (?s=<key>). ----
const STORES = {
  lehi: {
    name: "Chubby's Express",
    city: "Lehi, Utah",
    googleReviewUrl: "https://search.google.com/local/writereview?placeid=ChIJ5UZh6GJ_TYcRSu4wUnUo_9U",
  },
};

const HAPPY_FROM = 4;                 // 4 and 5 stars are "happy"
const OFFER = "Free cookie on your next visit";
const COUPON_DAYS = 30;               // coupon is valid this many days
const COUPON_COOLDOWN_DAYS = 7;       // one coupon per phone per this many days
const FOLLOWUP_HOURS = 24;            // unresolved complaints are re-sent after this long
const PIN_TRIES = 10;                 // wrong PINs allowed per 15 minutes per network
const DAY = 24 * 60 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS responses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     token TEXT NOT NULL UNIQUE,
     store TEXT NOT NULL,
     rating INTEGER NOT NULL,
     comment TEXT, name TEXT, phone TEXT,
     device TEXT,
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'none',
     alerted_at INTEGER, followup_at INTEGER,
     resolved_at INTEGER, resolved_by TEXT, resolved_note TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS coupons (
     code TEXT PRIMARY KEY,
     response_id INTEGER NOT NULL,
     store TEXT NOT NULL,
     device TEXT,
     issued_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     redeemed_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS pin_fails (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_status ON responses (status, alerted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_coupons_device ON coupons (device, issued_at)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  // Added after launch: when the guest tapped a Google review link. The command
  // fails harmlessly once the column exists.
  try {
    await db.prepare("ALTER TABLE responses ADD COLUMN google_clicked_at INTEGER").run();
  } catch {}
  schemaReady = true;
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function randomString(length, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
const newToken = () => randomString(32, "abcdefghijklmnopqrstuvwxyz0123456789");
// No 0/O, 1/I/L so a code is easy to read off a phone.
const newCouponCode = () => "CK" + randomString(6, "ABCDEFGHJKMNPQRSTUVWXYZ23456789");

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Checks the staff PIN and slows down guessing. Returns null when the PIN is right,
// otherwise the response to send back.
const checkPin = (env, request, pin) => checkSecret(env, request, pin, env.STAFF_PIN, "PIN");
const checkManager = (env, request, password) => checkSecret(env, request, password, env.MANAGER_PASSWORD, "password");

async function checkSecret(env, request, given, expected, word) {
  if (!expected) return json({ error: `The ${word} has not been set up yet.` }, 503);
  const pin = given;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const since = now - 15 * 60 * 1000;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pin_fails WHERE ip = ? AND at > ?").bind(ip, since).first();
  if (row && row.n >= PIN_TRIES) return json({ error: "Too many wrong tries. Try again in 15 minutes." }, 429);
  if (sameText(String(pin || ""), String(expected))) return null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pin_fails (ip, at) VALUES (?, ?)").bind(ip, now),
    env.DB.prepare("DELETE FROM pin_fails WHERE at < ?").bind(now - DAY),
  ]);
  return json({ error: `Wrong ${word}.` }, 401);
}

async function postToChat(url, text) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const when = (ms) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" });
const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

function complaintText(heading, r, origin) {
  const store = STORES[r.store] || { name: r.store, city: "" };
  return [
    `*${heading}*`,
    `${store.name} (${store.city})  ${stars(r.rating)}  ${when(r.created_at)}`,
    `*What went wrong:* ${r.comment || "(left blank)"}`,
    `*Guest:* ${r.name || "(no name)"}   *Phone:* ${r.phone || "(no phone)"}`,
    `Mark resolved: ${origin}/resolve?t=${r.token}`,
  ].join("\n");
}

// Re-sends complaints that are still open after 24 hours. Runs from the hourly check
// and also whenever a guest submits a rating, so it does not depend on one trigger.
async function runFollowups(env, origin) {
  const cutoff = Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    "SELECT * FROM responses WHERE status = 'open' AND followup_at IS NULL AND alerted_at IS NOT NULL AND alerted_at <= ? LIMIT 20"
  ).bind(cutoff).all();
  let sent = 0;
  for (const r of results) {
    const ok = await postToChat(
      env.CHAT_WEBHOOK_FOLLOWUP,
      complaintText(`Still unresolved after ${FOLLOWUP_HOURS} hours`, r, origin)
    );
    if (ok) {
      await env.DB.prepare("UPDATE responses SET followup_at = ? WHERE id = ?").bind(Date.now(), r.id).run();
      sent++;
    }
  }
  return { due: results.length, sent };
}

// ---- Guest: rating ----
async function handleRating(context, body, origin) {
  const { env, request } = context;
  const storeKey = clean(body.store, 40) || "lehi";
  if (!STORES[storeKey]) return json({ error: "Unknown store." }, 400);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: "Pick 1 to 5 stars." }, 400);

  const now = Date.now();
  let device = getCookie(request, "fbdev");
  const headers = {};
  if (!/^[a-z0-9]{32}$/.test(device)) {
    device = newToken();
    headers["set-cookie"] = `fbdev=${device}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
  }

  const token = newToken();
  const happy = rating >= HAPPY_FROM;
  const inserted = await env.DB.prepare(
    "INSERT INTO responses (token, store, rating, device, created_at, status) VALUES (?, ?, ?, ?, ?, 'none') RETURNING id"
  ).bind(token, storeKey, rating, device, now).first();

  // One coupon per phone per week: a repeat visit inside that window gets the same
  // coupon back if it is still unused, and no new one if it was already used.
  let coupon = null;
  const recent = await env.DB.prepare(
    "SELECT code, expires_at, redeemed_at FROM coupons WHERE device = ? AND issued_at > ? ORDER BY issued_at DESC LIMIT 1"
  ).bind(device, now - COUPON_COOLDOWN_DAYS * DAY).first();
  if (recent) {
    if (!recent.redeemed_at && recent.expires_at > now) coupon = { code: recent.code, expiresAt: recent.expires_at };
  } else {
    for (let attempt = 0; attempt < 5 && !coupon; attempt++) {
      const code = newCouponCode();
      const expiresAt = now + COUPON_DAYS * DAY;
      try {
        await env.DB.prepare(
          "INSERT INTO coupons (code, response_id, store, device, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(code, inserted.id, storeKey, device, now, expiresAt).run();
        coupon = { code, expiresAt };
      } catch {
        // code already exists: try another
      }
    }
  }

  context.waitUntil(runFollowups(env, origin).catch(() => {}));
  return json({ token, happy, coupon, offer: OFFER }, 200, headers);
}

// ---- Guest: "what went wrong" form ----
async function handleFeedback(context, body, origin) {
  const { env } = context;
  const token = clean(body.token, 64);
  const r = await env.DB.prepare("SELECT * FROM responses WHERE token = ?").bind(token).first();
  if (!r) return json({ error: "We could not find your rating. Please start again." }, 404);
  if (r.rating >= HAPPY_FROM) return json({ ok: true });
  if (r.alerted_at) return json({ ok: true }); // already sent once

  const comment = clean(body.comment, 2000);
  const name = clean(body.name, 80);
  const phone = clean(body.phone, 30);
  if (!comment && !phone) return json({ error: "Tell us what went wrong or leave a number so we can reach you." }, 400);

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE responses SET comment = ?, name = ?, phone = ?, status = 'open', alerted_at = ? WHERE id = ?"
  ).bind(comment, name, phone, now, r.id).run();

  const sent = await postToChat(
    env.CHAT_WEBHOOK_ALERTS,
    complaintText("New low rating", { ...r, comment, name, phone }, origin)
  );
  if (!sent) console.log("Chat alert was not delivered for response", r.id);
  return json({ ok: true });
}

// ---- Staff: redeem a coupon ----
async function handleRedeem(context, body) {
  const { env, request } = context;
  const denied = await checkPin(env, request, body.pin);
  if (denied) return denied;
  const code = clean(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return json({ error: "Type the code from the guest's phone." }, 400);
  const c = await env.DB.prepare("SELECT * FROM coupons WHERE code = ?").bind(code).first();
  if (!c) return json({ result: "unknown", message: "No coupon with that code. Check the letters and try again." });
  if (c.redeemed_at) return json({ result: "used", message: `Already used on ${when(c.redeemed_at)}.` });
  const now = Date.now();
  if (c.expires_at < now) return json({ result: "expired", message: `Expired on ${when(c.expires_at)}.` });
  const done = await env.DB.prepare("UPDATE coupons SET redeemed_at = ? WHERE code = ? AND redeemed_at IS NULL").bind(now, code).run();
  if (!done.meta.changes) return json({ result: "used", message: "Already used a moment ago." });
  return json({ result: "valid", message: `Valid. ${OFFER.replace(" on your next visit", "")}. Now marked as used.` });
}

// ---- Staff: mark a complaint resolved ----
async function handleResolve(context, body) {
  const { env, request } = context;
  // Staff use the PIN (from the alert link); the results page uses the manager password.
  const denied = body.password !== undefined
    ? await checkManager(env, request, body.password)
    : await checkPin(env, request, body.pin);
  if (denied) return denied;
  const token = clean(body.token, 64);
  const r = await env.DB.prepare("SELECT * FROM responses WHERE token = ?").bind(token).first();
  if (!r || r.status === "none") return json({ error: "No complaint found for this link." }, 404);
  const summary = { rating: r.rating, comment: r.comment, name: r.name, phone: r.phone, receivedAt: when(r.created_at) };
  if (r.status === "resolved") {
    return json({ result: "already", message: `Already resolved by ${r.resolved_by || "staff"} on ${when(r.resolved_at)}.`, summary });
  }
  const by = clean(body.by, 60);
  if (!by) return json({ error: "Type your name so we know who followed up." }, 400);
  await env.DB.prepare(
    "UPDATE responses SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolved_note = ? WHERE id = ?"
  ).bind(Date.now(), by, clean(body.note, 1000), r.id).run();
  return json({ result: "resolved", message: "Marked resolved. Thank you.", summary });
}

// ---- Guest tapped a Google review link (we can see the tap, not whether a review was posted) ----
async function handleClick(context, body) {
  const token = clean(body.token, 64);
  if (token) {
    await context.env.DB.prepare(
      "UPDATE responses SET google_clicked_at = ? WHERE token = ? AND google_clicked_at IS NULL"
    ).bind(Date.now(), token).run();
  }
  return json({ ok: true });
}

// ---- Owner and manager: results page ----
const denverDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // YYYY-MM-DD

async function handleResults(context, body) {
  const { env, request } = context;
  const denied = await checkManager(env, request, body.password);
  if (denied) return denied;

  const storeKey = clean(body.store, 40) || "lehi";
  if (!STORES[storeKey]) return json({ error: "Unknown store." }, 400);
  const days = [7, 30, 90, 365].includes(Number(body.days)) ? Number(body.days) : 30;
  const now = Date.now();
  const since = now - days * DAY;
  const db = env.DB;

  const [ratings, open, resolved, coupons] = await db.batch([
    db.prepare("SELECT rating, created_at, google_clicked_at FROM responses WHERE store = ? AND created_at > ? ORDER BY created_at LIMIT 20000").bind(storeKey, since),
    db.prepare("SELECT token, rating, comment, name, phone, created_at, alerted_at, followup_at FROM responses WHERE store = ? AND status = 'open' ORDER BY alerted_at").bind(storeKey),
    db.prepare("SELECT rating, comment, name, phone, created_at, resolved_at, resolved_by, resolved_note FROM responses WHERE store = ? AND status = 'resolved' AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 100").bind(storeKey, since),
    db.prepare(
      `SELECT COUNT(*) AS issued,
              SUM(CASE WHEN redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed,
              SUM(CASE WHEN redeemed_at IS NULL AND expires_at < ?1 THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN redeemed_at IS NULL AND expires_at >= ?1 THEN 1 ELSE 0 END) AS unused
       FROM coupons WHERE store = ?2 AND issued_at > ?3`
    ).bind(now, storeKey, since),
  ]);

  const rows = ratings.results;
  const byStar = [0, 0, 0, 0, 0];
  const byDay = new Map();
  let sum = 0, happy = 0, clicks = 0;
  for (const r of rows) {
    byStar[r.rating - 1]++;
    sum += r.rating;
    if (r.rating >= HAPPY_FROM) happy++;
    if (r.google_clicked_at) clicks++;
    const day = denverDay(r.created_at);
    const d = byDay.get(day) || { day, count: 0, sum: 0, happy: 0 };
    d.count++; d.sum += r.rating; if (r.rating >= HAPPY_FROM) d.happy++;
    byDay.set(day, d);
  }
  const c = coupons.results[0] || {};
  const store = STORES[storeKey];
  return json({
    store: { key: storeKey, name: store.name, city: store.city },
    days,
    summary: {
      ratings: rows.length,
      average: rows.length ? Math.round((sum / rows.length) * 100) / 100 : null,
      happy,
      happyShare: rows.length ? Math.round((happy / rows.length) * 100) : null,
      googleClicks: clicks,
      byStar,
    },
    daily: [...byDay.values()].reverse().map((d) => ({
      day: d.day, count: d.count, average: Math.round((d.sum / d.count) * 100) / 100, happy: d.happy,
    })),
    open: open.results.map((r) => ({
      token: r.token, rating: r.rating, comment: r.comment, name: r.name, phone: r.phone,
      receivedAt: when(r.created_at), hoursOpen: Math.floor((now - (r.alerted_at || r.created_at)) / 3600000),
      followedUp: Boolean(r.followup_at),
    })),
    resolved: resolved.results.map((r) => ({
      rating: r.rating, comment: r.comment, name: r.name, phone: r.phone,
      receivedAt: when(r.created_at), resolvedAt: when(r.resolved_at), resolvedBy: r.resolved_by, note: r.resolved_note,
    })),
    coupons: { issued: c.issued || 0, redeemed: c.redeemed || 0, expired: c.expired || 0, unused: c.unused || 0 },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const origin = url.origin;

  if (!env.DB) return json({ error: "The database is not connected yet." }, 503);

  try {
    await ensureSchema(env.DB);

    if (request.method === "GET" && route === "store") {
      const key = url.searchParams.get("s") || "lehi";
      const store = STORES[key];
      if (!store) return json({ error: "Unknown store." }, 404);
      return json({ key, name: store.name, city: store.city, googleReviewUrl: store.googleReviewUrl, offer: OFFER, happyFrom: HAPPY_FROM });
    }

    if (route === "cron") {
      const key = url.searchParams.get("key") || request.headers.get("x-cron-key") || "";
      if (!env.CRON_KEY || !sameText(key, String(env.CRON_KEY))) return json({ error: "Not allowed." }, 401);
      return json(await runFollowups(env, origin));
    }

    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request." }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "Bad request." }, 400);

    if (route === "rating") return await handleRating(context, body, origin);
    if (route === "feedback") return await handleFeedback(context, body, origin);
    if (route === "redeem") return await handleRedeem(context, body);
    if (route === "resolve") return await handleResolve(context, body);
    if (route === "click") return await handleClick(context, body);
    if (route === "results") return await handleResults(context, body);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.log("Error:", err && err.stack ? err.stack : err);
    return json({ error: "Something went wrong on our side. Please try again." }, 500);
  }
}
