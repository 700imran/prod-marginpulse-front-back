// Cross-stack: the sidecar's REAL gateway code (extensions/whatsapp-gateway) talks to the REAL Worker app + Postgres.
// Covers the LINK ownership handshake, document ingestion into the OCR queue, replies, de-duplication, bad signatures,
// stale timestamps, rejected file types and "unknown number gets no reply".
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/index.ts";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
// @ts-ignore — plain JS module from the sidecar, imported to prove the two sides agree on the wire format
import { createGateway } from "../../extensions/whatsapp-gateway/src/gateway.js";
// @ts-ignore
import { signBody } from "../../extensions/whatsapp-gateway/src/sign.js";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
const store = new Map<string, ArrayBuffer>();
const keepAlive = setInterval(() => {}, 1000);
const SECRET = "wa-secret-test", URL_ = "https://api.test/webhook/whatsapp-gateway";
const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
const quiet = { info() {}, warn() {}, error() {} };

before(async () => {
  if (skip) return;
  h = await startHarness();
  Object.assign(h.env, { WA_GATEWAY_WEBHOOK_SECRET: SECRET, WA_GATEWAY_NUMBER: "919000000000" });
  h.env.DOCS_BUCKET = { put: async (k: string, d: ArrayBuffer) => { store.set(k, d); }, get: async () => null, delete: async () => {} };
});
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });

// The sidecar's fetch goes straight into the Worker app (no network).
const toWorker = (u: any, init: any) => app.fetch(new Request(u, init), h.env, ctx);
const sidecar = () => {
  const sent: [string, string][] = [];
  const g = createGateway({ workerUrl: URL_, webhookSecret: SECRET, fetchImpl: toWorker, log: quiet, sleep: async () => {} });
  return { g, sent, deps: { download: async () => Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF"), sendText: async (to: string, t: string) => { sent.push([to, t]); } } };
};
const phone = () => `9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
const msg = (from: string, content: object, id = `WA${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`) => ({ key: { id, remoteJid: `${from}@s.whatsapp.net` }, message: content });
const text = (from: string, t: string) => msg(from, { conversation: t });
const pdf = (from: string, name = "inv-2001.pdf", id?: string) => msg(from, { documentMessage: { fileName: name, mimetype: "application/pdf", fileLength: 40 } }, id);
const mkTenant = async (label: string) => { const t = await h.newTenant(label); await h.admin`insert into tenants (tenant_id, business_name, owner_email) values (${t.tenantId}, ${label}, ${t.email}) on conflict do nothing`; return t; };
const boundTo = async (id: string) => (await h.admin<any[]>`select whatsapp_binding_phone as p from tenants where tenant_id = ${id}`)[0]?.p;

test("linking: code from the app + `LINK <code>` from the phone binds the number; the reply confirms; a code works once", { skip }, async () => {
  const t = await mkTenant("wa-link"), { g, sent, deps } = sidecar(), from = phone();
  assert.equal((await h.call(t.token, "GET", "/api/v1/settings/whatsapp")).json.boundPhone, null);
  const lc = await h.call(t.token, "POST", "/api/v1/settings/whatsapp/link-code");
  assert.equal(lc.status, 200, lc.text);
  assert.match(lc.json.code, /^[A-HJ-NP-Z2-9]{6}$/); assert.equal(lc.json.sendTo, "919000000000"); assert.equal(lc.json.message, `LINK ${lc.json.code}`);
  assert.equal((await g.handleMessage(text(from, "LINK AAAAAA"), deps)).outcome, "link_failed");
  assert.match(sent.at(-1)![1], /invalid or has expired/);
  assert.equal(await boundTo(t.tenantId), null, "a wrong code binds nothing");
  assert.equal((await g.handleMessage(text(from, `link ${lc.json.code.toLowerCase()}`), deps)).outcome, "linked");
  assert.match(sent.at(-1)![1], /now linked/);
  assert.equal(await boundTo(t.tenantId), from);
  const st = await h.call(t.token, "GET", "/api/v1/settings/whatsapp");
  assert.match(st.json.boundPhone, /^\+91•+\d{4}$/); assert.ok(!st.text.includes(from), "the full number is never returned by the settings API");
  assert.equal((await g.handleMessage(text(phone(), `LINK ${lc.json.code}`), deps)).outcome, "link_failed", "the code is single-use");
});

test("linking: a number already bound to another account is refused and leaves the new account's code intact; expiry and unlink work", { skip }, async () => {
  const a = await mkTenant("wa-a"), b = await mkTenant("wa-b"), { g, sent, deps } = sidecar(), from = phone();
  const ca = (await h.call(a.token, "POST", "/api/v1/settings/whatsapp/link-code")).json.code;
  await g.handleMessage(text(from, `LINK ${ca}`), deps);
  const cb = (await h.call(b.token, "POST", "/api/v1/settings/whatsapp/link-code")).json.code;
  await g.handleMessage(text(from, `LINK ${cb}`), deps);
  assert.match(sent.at(-1)![1], /already linked to another/);
  assert.equal(await boundTo(b.tenantId), null);
  assert.equal((await h.admin<any[]>`select count(*)::int as n from whatsapp_link_codes where tenant_id = ${b.tenantId}`)[0].n, 1, "code survives a conflict so B can retry with another number");

  const c = await mkTenant("wa-exp"), cc = (await h.call(c.token, "POST", "/api/v1/settings/whatsapp/link-code")).json.code;
  await h.admin`update whatsapp_link_codes set expires_at = now() - interval '1 second' where tenant_id = ${c.tenantId}`;
  await g.handleMessage(text(phone(), `LINK ${cc}`), deps);
  assert.match(sent.at(-1)![1], /invalid or has expired/);

  assert.equal((await h.call(a.token, "DELETE", "/api/v1/settings/whatsapp")).json.boundPhone, null);
  assert.equal(await boundTo(a.tenantId), null);
  assert.equal((await h.call(a.token, "POST", "/api/v1/settings/whatsapp/link-code")).status, 200);
});

test("document from a linked number → stored, document row + OCR job created, confirmation sent; a redelivered message creates nothing new", { skip }, async () => {
  const t = await mkTenant("wa-doc"), { g, sent, deps } = sidecar(), from = phone();
  await h.admin`update tenants set whatsapp_binding_phone = ${from} where tenant_id = ${t.tenantId}`;
  const before = h.queues.OCR_QUEUE.sentTotal, files = store.size;
  const evId = `WA${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`; // event ids are remembered across runs (that is the point of dedupe)
  const m = pdf(from, "inv-2001.pdf", evId);
  assert.equal((await g.handleMessage(m, deps)).outcome, "received");
  assert.equal(store.size, files + 1); assert.equal(h.queues.OCR_QUEUE.sentTotal, before + 1);
  const docs = await h.admin<any[]>`select original_filename, ingest_channel, whatsapp_message_id, sender_phone, mime_type from documents where tenant_id = ${t.tenantId}`;
  assert.deepEqual(docs.map((d) => [d.original_filename, d.ingest_channel, d.whatsapp_message_id, d.sender_phone, d.mime_type]), [["inv-2001.pdf", "WHATSAPP", evId, from, "application/pdf"]]);
  assert.match(sent.at(-1)![1], /Received inv-2001.pdf/);
  // The sidecar itself dedupes, so go to the Worker directly to prove the Worker also dedupes on event_id (a retry after a lost response).
  const raw = JSON.stringify({ event_id: evId, type: "document", from, filename: "inv-2001.pdf", mime_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 x").toString("base64") });
  const dup = await toWorker(URL_, { method: "POST", headers: { "X-WA-Signature": signBody(SECRET, raw) }, body: raw });
  assert.equal(((await dup.json()) as any).status, "duplicate");
  assert.equal((await h.admin<any[]>`select count(*)::int as n from documents where tenant_id = ${t.tenantId}`)[0].n, 1);
});

test("unknown numbers get no reply and nothing is stored; unsupported file types are refused politely", { skip }, async () => {
  const { g, sent, deps } = sidecar(), stranger = phone();
  const files = store.size;
  assert.equal((await g.handleMessage(pdf(stranger), deps)).outcome, "unbound_number");
  assert.deepEqual(sent, [], "never message strangers from a ban-prone number");
  assert.equal(store.size, files);
  const t = await mkTenant("wa-exe"), from = phone();
  await h.admin`update tenants set whatsapp_binding_phone = ${from} where tenant_id = ${t.tenantId}`;
  const exe = msg(from, { documentMessage: { fileName: "setup.exe", mimetype: "application/x-msdownload", fileLength: 20 } });
  assert.equal((await g.handleMessage(exe, { ...deps, download: async () => Buffer.from("MZ\x90\x00 not a pdf") })).outcome, "rejected");
  assert.match(sent.at(-1)![1], /PDF, JPG or PNG/);
  assert.equal((await h.admin<any[]>`select count(*)::int as n from documents where tenant_id = ${t.tenantId}`)[0].n, 0);
});

test("the Worker refuses unsigned, wrongly signed and stale requests, and is off when no secret is configured", { skip }, async () => {
  const raw = JSON.stringify({ event_id: `EV${crypto.randomUUID().slice(0, 12)}`, type: "text", from: phone(), text: "LINK AAAAAA" });
  const post = (headers: Record<string, string>, env: any = h.env) => app.fetch(new Request(URL_, { method: "POST", headers, body: raw }), env, ctx);
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ "X-WA-Signature": signBody("wrong", raw) })).status, 401);
  assert.equal((await post({ "X-WA-Signature": signBody(SECRET, raw, Math.floor(Date.now() / 1000) - 600) })).status, 401);
  assert.equal((await post({ "X-WA-Signature": signBody(SECRET, raw + " ") })).status, 401, "body tampering");
  assert.equal((await post({ "X-WA-Signature": signBody(SECRET, raw) })).status, 200);
  assert.equal((await post({ "X-WA-Signature": signBody(SECRET, raw) }, { ...h.env, WA_GATEWAY_WEBHOOK_SECRET: "" })).status, 503);
  const bad = JSON.stringify({ event_id: "EVENT0002", type: "document", from: "abc" });
  assert.equal((await app.fetch(new Request(URL_, { method: "POST", headers: { "X-WA-Signature": signBody(SECRET, bad) }, body: bad }), h.env, ctx)).status, 400);
});

test("link codes are not offered when the gateway is not configured; the existing Meta webhook still verifies its signature", { skip }, async () => {
  const t = await mkTenant("wa-off");
  const saved = h.env.WA_GATEWAY_WEBHOOK_SECRET; h.env.WA_GATEWAY_WEBHOOK_SECRET = "";
  try {
    assert.equal((await h.call(t.token, "GET", "/api/v1/settings/whatsapp")).json.gatewayEnabled, false);
    assert.equal((await h.call(t.token, "POST", "/api/v1/settings/whatsapp/link-code")).status, 404);
  } finally { h.env.WA_GATEWAY_WEBHOOK_SECRET = saved; }
  Object.assign(h.env, { WHATSAPP_APP_SECRET: "meta-secret", ENVIRONMENT: "production" });
  try {
    const r = await app.fetch(new Request("https://api.test/webhook/whatsapp", { method: "POST", headers: { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) }, body: "{}" }), h.env, ctx);
    assert.equal(r.status, 401);
  } finally { delete h.env.WHATSAPP_APP_SECRET; h.env.ENVIRONMENT = "test"; }
});
