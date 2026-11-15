import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { signBody } from "../src/sign.js";
import { parseInbound } from "../src/inbound.js";
import { createGateway } from "../src/gateway.js";
import { createConnection } from "../src/connection.js";
import { createHttpServer } from "../src/http.js";
import { createMetrics } from "../src/metrics.js";

const quiet = { info() {}, warn() {}, error() {} };
const PN = "919876543210@s.whatsapp.net";
const docMsg = (o = {}) => ({ key: { id: "ABCDEF123456", remoteJid: PN, fromMe: false }, message: { documentMessage: { fileName: "inv-1001.pdf", mimetype: "application/pdf", fileLength: 2048 } }, ...o });
const res = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test("signBody is the exact scheme the Worker verifies: t=<unix>,v1=hmac-sha256('t.rawBody')", () => {
  const sig = signBody("sec", '{"a":1}', 1731400000);
  assert.equal(sig, `t=1731400000,v1=${createHmac("sha256", "sec").update('1731400000.{"a":1}').digest("hex")}`);
});

test("parseInbound: accepts documents/images from a 1:1 phone-number chat; skips everything else with a reason", () => {
  assert.deepEqual(parseInbound(docMsg()), { ok: true, eventId: "ABCDEF123456", from: "919876543210", type: "document", filename: "inv-1001.pdf", mimeType: "application/pdf", size: 2048 });
  assert.equal(parseInbound({ key: { id: "I1", remoteJid: PN }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: { toNumber: () => 99 } } } }).size, 99, "protobuf Long sizes");
  assert.equal(parseInbound({ key: { id: "W1", remoteJid: PN }, message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "a.pdf", mimetype: "application/pdf" } } } } } } }).type, "document", "disappearing-message wrappers");
  const skip = (m) => parseInbound(m).reason;
  assert.equal(skip(docMsg({ key: { id: "x1", remoteJid: PN, fromMe: true } })), "own");
  assert.equal(skip(docMsg({ key: { id: "x2", remoteJid: "12345-678@g.us" } })), "not_direct");
  assert.equal(skip(docMsg({ key: { id: "x3", remoteJid: "status@broadcast" } })), "not_direct");
  assert.equal(skip(docMsg({ key: { id: "x4", remoteJid: "1234567890123@lid" } })), "no_phone_number");
  assert.equal(parseInbound(docMsg({ key: { id: "x5", remoteJid: "1234567890123@lid", remoteJidAlt: PN } })).from, "919876543210", "a LID chat with a phone-number alias is usable");
  assert.equal(skip({ key: { id: "x6", remoteJid: PN }, message: { conversation: "hi" } }), "unsupported_type");
  assert.equal(skip({ key: { id: "x7", remoteJid: PN } }), "empty");
});

test("LINK handshake: only `LINK <code>` text is forwarded (as text, upper-cased); other chat text is never sent anywhere; guesses are rate-limited per sender", async () => {
  const bodies = [], sent = [];
  const g = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: quiet, sleep: async () => {}, fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body)); return res(200, { status: "link_failed", reply: "invalid" }); } });
  const deps = { download: async () => { throw new Error("must not download"); }, sendText: async (to, t) => sent.push([to, t]) };
  const txt = (id, t, ext = false) => ({ key: { id, remoteJid: PN }, message: ext ? { extendedTextMessage: { text: t } } : { conversation: t } });
  assert.equal(parseInbound(txt("T0000001", "hello there")).reason, "unsupported_type", "private chat text is ignored");
  assert.equal(parseInbound(txt("T0000002", "LINK abc12")).reason, "unsupported_type");
  assert.deepEqual(bodies, []);
  await g.handleMessage(txt("T0000003", " link k7m2qx "), deps);
  assert.deepEqual(bodies[0], { event_id: "T0000003", type: "text", from: "919876543210", text: "LINK K7M2QX" });
  assert.deepEqual(sent, [["919876543210", "invalid"]]);
  for (let i = 4; i <= 7; i++) await g.handleMessage(txt("T000000" + i, "LINK K7M2Q" + i, i % 2 === 0), deps);
  assert.equal((await g.handleMessage(txt("T0000008", "LINK ZZZZZZ"), deps)).outcome, "link_rate_limited", "6th guess inside an hour is dropped");
  assert.equal(bodies.length, 5);
});

test("forward: signs each attempt; retries 5xx/429/network with backoff + Retry-After; stops at the first success", async () => {
  const sleeps = [], calls = [];
  const script = [() => { throw new Error("ECONNRESET"); }, () => res(503), () => res(429, {}, { "retry-after": "7" }), () => res(200, { status: "received" })];
  let t = 1_731_400_000_000;
  const g = createGateway({ workerUrl: "https://api.test/webhook/whatsapp-gateway", webhookSecret: "sec", log: quiet, now: () => t, random: () => 1, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return script[calls.length - 1](); } });
  const r = await g.forward({ event_id: "E1", from: "1" });
  assert.deepEqual(r, { ok: true, body: { status: "received" } });
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 7000], "exponential backoff, and the server's Retry-After wins when larger");
  const stamps = calls.map((c) => /t=(\d+)/.exec(c.init.headers["X-WA-Signature"])[1]);
  assert.equal(new Set(stamps).size > 1, true, "every attempt is re-signed with a fresh timestamp");
  for (const c of calls) assert.equal(c.init.headers["X-WA-Signature"], signBody("sec", c.init.body, Number(/t=(\d+)/.exec(c.init.headers["X-WA-Signature"])[1])));
  assert.equal(g.metrics.get("mp_wa_forward_attempts_total", { result: "ok" }), 1);
  assert.equal(g.metrics.get("mp_wa_forward_attempts_total", { result: "network_error" }), 1);
});

test("forward: a 4xx (bad secret) is never retried and is reported as non-retryable; exhausting retries reports retryable", async () => {
  let n = 0; const errors = [];
  const g = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: { ...quiet, error: (m) => errors.push(m) }, sleep: async () => {}, fetchImpl: async () => { n++; return res(401); } });
  const r = await g.forward({ event_id: "E2" });
  assert.deepEqual([r.ok, r.retryable, n], [false, false, 1]);
  assert.match(errors[0], /does not match/);
  n = 0;
  const g2 = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: quiet, sleep: async () => {}, maxAttempts: 3, fetchImpl: async () => { n++; return res(500); } });
  assert.deepEqual([(await g2.forward({ event_id: "E3" })).retryable, n], [true, 3]);
});

test("handleMessage: forwards the file, replies with the Worker's text once per rate window, de-duplicates a re-delivered message", async () => {
  const sent = [], bodies = [];
  const g = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: quiet, sleep: async () => {}, replyLimit: { max: 2, windowMs: 60_000 },
    fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body)); return res(200, { status: "received", reply: "✅ Received inv-1001.pdf" }); } });
  const deps = { download: async () => Buffer.from("%PDF-1.4 hello"), sendText: async (to, text) => sent.push([to, text]) };
  assert.equal((await g.handleMessage(docMsg(), deps)).outcome, "received");
  assert.deepEqual(bodies[0], { event_id: "ABCDEF123456", type: "document", from: "919876543210", filename: "inv-1001.pdf", mime_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 hello").toString("base64") });
  assert.deepEqual(sent, [["919876543210", "✅ Received inv-1001.pdf"]]);
  assert.equal((await g.handleMessage(docMsg(), deps)).outcome, "duplicate");
  assert.equal(bodies.length, 1);
  await g.handleMessage(docMsg({ key: { id: "ID2", remoteJid: PN } }), deps);
  await g.handleMessage(docMsg({ key: { id: "ID3", remoteJid: PN } }), deps);
  assert.equal(sent.length, 2, "reply flood protection: third reply inside the window is suppressed");
  assert.equal(g.metrics.get("mp_wa_replies_total", { outcome: "rate_limited" }), 1);
  assert.equal((await g.handleMessage({ key: { id: "G1", remoteJid: "1-2@g.us" }, message: { documentMessage: {} } }, deps)).outcome, "skipped");
});

test("handleMessage: oversize files are refused before download; a failed download can be retried on redelivery", async () => {
  let downloads = 0; const sent = [];
  const g = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: quiet, sleep: async () => {}, fetchImpl: async () => res(200, { status: "received" }) });
  const big = docMsg({ message: { documentMessage: { fileName: "x.pdf", mimetype: "application/pdf", fileLength: 20 * 1024 * 1024 } } });
  assert.equal((await g.handleMessage(big, { download: async () => { downloads++; return Buffer.alloc(1); }, sendText: async (...a) => sent.push(a) })).outcome, "too_large");
  assert.equal(downloads, 0); assert.match(sent[0][1], /15 MB/);
  const m = docMsg({ key: { id: "RETRY1", remoteJid: PN } });
  assert.equal((await g.handleMessage(m, { download: async () => { throw new Error("media expired"); }, sendText: async () => {} })).outcome, "download_failed");
  assert.equal((await g.handleMessage(m, { download: async () => Buffer.from("x"), sendText: async () => {} })).outcome, "received", "not marked as seen after a failed download");
});

test("Worker outage: payload is spooled atomically to disk, then delivered by retrySpool when the Worker recovers; expired files are dropped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-spool-"));
  let up = false, t = Date.now(); const delivered = [];
  const g = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: quiet, sleep: async () => {}, maxAttempts: 2, spoolDir: dir, now: () => t,
    fetchImpl: async (_u, init) => { if (!up) return res(503); delivered.push(JSON.parse(init.body).event_id); return res(200, { status: "received" }); } });
  const deps = { download: async () => Buffer.from("data"), sendText: async () => {} };
  assert.equal((await g.handleMessage(docMsg(), deps)).outcome, "spooled");
  assert.equal((await fs.readdir(dir)).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")).length, 0, "no half-written files");
  assert.deepEqual(await g.retrySpool(), { delivered: 0, remaining: 1, expired: 0 }, "still down: file stays, no data loss");
  up = true;
  assert.deepEqual(await g.retrySpool(), { delivered: 1, remaining: 0, expired: 0 });
  assert.deepEqual(delivered, ["ABCDEF123456"]);
  up = false; await g.handleMessage(docMsg({ key: { id: "OLD00001", remoteJid: PN } }), deps);
  t += 25 * 3_600_000;
  assert.deepEqual(await g.retrySpool(), { delivered: 0, remaining: 0, expired: 1 });
  assert.equal(g.metrics.get("mp_wa_spool_expired_total"), 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("without a spool dir an unrecoverable outage is reported as 'lost' (and logged), not silently swallowed", async () => {
  const errs = [];
  const g = createGateway({ workerUrl: "https://x", webhookSecret: "s", log: { ...quiet, error: (m) => errs.push(m) }, sleep: async () => {}, maxAttempts: 1, fetchImpl: async () => res(500) });
  assert.equal((await g.handleMessage(docMsg(), { download: async () => Buffer.from("x"), sendText: async () => {} })).outcome, "lost");
  assert.ok(errs.some((e) => /wa_message_lost/.test(e)));
});

// ── connection: reconnect/backoff/logout with a fake Baileys ─────────────────
function fakeBaileys() {
  const made = [];
  const b = {
    default: () => { const ev = new EventEmitter(); const s = { ev, sent: [], sendMessage: async (jid, c) => s.sent.push([jid, c]), end() { s.ended = true; } }; made.push(s); return s; },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    downloadMediaMessage: async () => Buffer.from("file"),
    DisconnectReason: { loggedOut: 401, restartRequired: 515 }, Browsers: { macOS: () => ["MarginPulse", "Desktop", "1"] },
  };
  return { b, made };
}
const tick = () => new Promise((r) => setImmediate(r));
const close = (code) => ({ connection: "close", lastDisconnect: { error: { output: { statusCode: code } } } });

test("connection: QR → open; transient close reconnects with growing backoff; restartRequired reconnects immediately; loggedOut stops and says why", async () => {
  const { b, made } = fakeBaileys(); const sleeps = []; const metrics = createMetrics(); const errs = [];
  const c = createConnection({ baileys: b, authDir: "x", metrics, log: { ...quiet, error: (m) => errs.push(m) }, random: () => 1, sleep: async (ms) => sleeps.push(ms), onMessage: async () => {} });
  await c.start(); assert.equal(c.getState(), "starting");
  made[0].ev.emit("connection.update", { qr: "QRDATA" }); await tick();
  assert.deepEqual([c.getState(), c.getQr()], ["qr", "QRDATA"]);
  made[0].ev.emit("connection.update", { connection: "open" }); await tick();
  assert.deepEqual([c.getState(), c.getQr(), metrics.get("mp_wa_connection_up")], ["open", null, 1]);

  made[0].ev.emit("connection.update", close(428)); await tick(); await tick();
  assert.equal(made.length, 2, "reconnected with a fresh socket"); assert.deepEqual(sleeps, [1000]);
  made[1].ev.emit("connection.update", close(428)); await tick(); await tick();
  assert.deepEqual(sleeps, [1000, 2000], "backoff doubles while it keeps failing");
  made[2].ev.emit("connection.update", { connection: "open" }); await tick();
  made[2].ev.emit("connection.update", close(515)); await tick(); await tick();
  assert.equal(sleeps.at(-1), 0, "restartRequired is expected after pairing: reconnect now");
  made[3].ev.emit("connection.update", { connection: "open" }); await tick();
  made[3].ev.emit("connection.update", close(401)); await tick(); await tick();
  assert.equal(made.length, 4, "logged out: no reconnect loop"); assert.equal(c.getState(), "logged_out");
  assert.ok(errs.some((e) => /wa_logged_out/.test(e)));
  assert.ok(metrics.get("mp_wa_reconnects_total", { reason: "428" }) >= 2);
});

test("connection: a start failure (corrupt auth dir) retries with backoff instead of crashing; messages.upsert only handles 'notify'; send is guarded", async () => {
  const { b, made } = fakeBaileys(); const sleeps = []; const handled = []; let fail = 1;
  const orig = b.useMultiFileAuthState; b.useMultiFileAuthState = async (...a) => { if (fail-- > 0) throw new Error("EACCES"); return orig(...a); };
  const c = createConnection({ baileys: b, authDir: "x", log: quiet, random: () => 1, sleep: async (ms) => sleeps.push(ms), onMessage: async (m) => handled.push(m.key.id), sendLimit: { max: 2, windowMs: 60_000 } });
  await c.start(); assert.deepEqual(sleeps, [1000]); assert.equal(made.length, 1, "second attempt succeeded");
  made[0].ev.emit("messages.upsert", { type: "append", messages: [docMsg({ key: { id: "HIST1", remoteJid: PN } })] });
  made[0].ev.emit("messages.upsert", { type: "notify", messages: [docMsg({ key: { id: "NEW1", remoteJid: PN } })] });
  assert.deepEqual(handled, ["NEW1"]);
  await assert.rejects(c.sendText("919876543210", "hi"), /not connected/);
  made[0].ev.emit("connection.update", { connection: "open" }); await tick();
  await assert.rejects(c.sendText("abc", "hi"), /invalid recipient/);
  await c.sendText("919876543210", "one"); await c.sendText("919876543210", "two");
  await assert.rejects(c.sendText("919876543210", "three"), /rate limit/);
  assert.deepEqual(made[0].sent[0], ["919876543210@s.whatsapp.net", { text: "one" }]);
});

// ── HTTP ops surface ─────────────────────────────────────────────────────────
test("HTTP: /health is public; everything else needs the bearer token; /metrics is Prometheus text; /send validates and maps errors", async () => {
  const metrics = createMetrics(); metrics.describe("mp_wa_connection_up", "up", "gauge"); metrics.set("mp_wa_connection_up", 1); metrics.inc("mp_wa_messages_total", { outcome: 'we"ird' });
  let state = "open"; const sent = [];
  const srv = createHttpServer({ token: "tok", metrics, getState: () => state, getQr: () => (state === "qr" ? "QR1" : null), sendText: async (to, text) => { if (to === "0") throw new Error("not connected"); sent.push([to, text]); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (p, init = {}, auth = true) => fetch(base + p, { ...init, headers: { ...(auth ? { Authorization: "Bearer tok" } : {}), "Content-Type": "application/json" } });
  try {
    assert.equal((await call("/health", {}, false)).status, 200);
    for (const p of ["/metrics", "/ready", "/qr", "/qr.svg"]) assert.equal((await call(p, {}, false)).status, 401, p);
    assert.equal((await fetch(base + "/metrics", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const m = await (await call("/metrics")).text();
    assert.match(m, /# TYPE mp_wa_connection_up gauge\nmp_wa_connection_up 1/); assert.match(m, /mp_wa_messages_total\{outcome="we\\"ird"\} 1/);
    assert.equal((await call("/ready")).status, 200);
    assert.equal((await call("/qr")).status, 404);
    state = "qr"; assert.equal((await (await call("/qr")).json()).qr, "QR1");
    const svg = await call("/qr.svg"); assert.equal(svg.headers.get("content-type"), "image/svg+xml"); assert.match(await svg.text(), /<svg/);
    assert.equal((await call("/ready")).status, 503);
    assert.equal((await call("/send", { method: "POST", body: JSON.stringify({ to: "919876543210", text: "hello" }) })).status, 200);
    assert.deepEqual(sent, [["919876543210", "hello"]]);
    assert.equal((await call("/send", { method: "POST", body: "{}" })).status, 400);
    assert.equal((await call("/send", { method: "POST", body: JSON.stringify({ to: "0", text: "x" }) })).status, 503);
    assert.equal((await call("/send", { method: "POST", body: "x".repeat(9000) })).status, 413);
  } finally { srv.close(); }
});
