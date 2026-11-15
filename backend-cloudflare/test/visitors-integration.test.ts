// Visitor tracking against the real app + real Postgres: consent gate, origin→site mapping, bot filter, 30-minute session
// window, IP truncation, erase, retention purge, credential-less CORS, admin summary, and "analytics never breaks a page".
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/index.ts";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { purgeOldVisitors } from "../src/repository/visitors.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
const keepAlive = setInterval(() => {}, 1000);
const MKT = "https://marginpulse.in";
const APP = "https://app.marginpulse.in";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
before(async () => { if (!skip) { h = await startHarness(); h.env.TRACKING_ORIGINS = MKT; h.env.VISITOR_RETENTION_DAYS = "90"; await h.admin`delete from visitors`; } });
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });

const uuid = () => crypto.randomUUID();
const visit = (body: unknown, origin = MKT, ua = CHROME, ip = "203.0.113.77", env: any = undefined) =>
  app.fetch(new Request("https://api.test/api/v1/track/visit", { method: "POST", headers: { Origin: origin, "User-Agent": ua, "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env ?? h.env, { waitUntil() {}, passThroughOnException() {} } as any);
const row = async (id: string, site = "marketing") => (await h.admin<any[]>`select * from visitors where site = ${site} and visitor_id = ${id}`)[0];

test("without consent:true nothing is stored", { skip }, async () => {
  const id = uuid();
  assert.equal((await visit({ visitorId: id })).status, 400);
  assert.equal((await visit({ consent: "yes", visitorId: id })).status, 400);
  assert.equal(await row(id), undefined);
});

test("only the marketing site and the app may report; an unknown origin is rejected", { skip }, async () => {
  assert.equal((await visit({ consent: true, visitorId: uuid() }, "https://evil.example")).status, 403);
  const noOrigin = await app.fetch(new Request("https://api.test/api/v1/track/visit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true, visitorId: uuid() }) }), h.env, { waitUntil() {}, passThroughOnException() {} } as any);
  assert.equal(noOrigin.status, 403);
});

test("new visitor stored with truncated IP + device; same session doesn't inflate; 31 min later is a new visit", { skip }, async () => {
  const id = uuid();
  const r1 = await visit({ consent: true, visitorId: id });
  assert.equal(r1.status, 202);
  const j1: any = await r1.json();
  assert.deepEqual([j1.counted, j1.newVisitor, j1.visits], [true, true, 1]);
  const r = await row(id);
  assert.equal(r.site, "marketing"); assert.equal(r.last_ip, "203.0.113.0"); assert.equal(r.device, "desktop"); assert.equal(r.browser, "Chrome"); assert.equal(r.id_source, "first_party");
  assert.ok(!JSON.stringify(r).includes("203.0.113.77"), "full IP must never be stored");

  const j2: any = await (await visit({ consent: true, visitorId: id })).json();
  assert.deepEqual([j2.newVisitor, j2.visits], [false, 1]); // same session

  await h.admin`update visitors set last_seen = now() - interval '31 minutes' where visitor_id = ${id}`;
  const j3: any = await (await visit({ consent: true, visitorId: id })).json();
  assert.equal(j3.visits, 2);                                // returning visitor, new session
});

test("the app and the marketing site are tracked separately; uppercase UUIDs normalise to one visitor", { skip }, async () => {
  const id = uuid();
  await visit({ consent: true, visitorId: id }, APP);
  await visit({ consent: true, visitorId: id.toUpperCase() }, MKT);
  assert.equal((await row(id, "app")).site, "app");
  assert.equal((await row(id, "marketing")).visitor_id, id);
});

test("bots and malformed ids are not counted", { skip }, async () => {
  const id = uuid();
  const b: any = await (await visit({ consent: true, visitorId: id }, MKT, "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).json();
  assert.equal(b.counted, false);
  assert.equal(await row(id), undefined);
  assert.equal((await visit({ consent: true, visitorId: "not-a-uuid" })).status, 400);
  assert.equal((await visit({ consent: true })).status, 400);
  assert.equal((await visit("[1,2]")).status, 400);
  assert.equal((await visit({ consent: true, visitorId: uuid(), pad: "x".repeat(3000) })).status, 413);
});

test("erase removes the visitor; purge removes rows past retention only", { skip }, async () => {
  const id = uuid(), old = uuid(), fresh = uuid();
  await visit({ consent: true, visitorId: id });
  const del = await app.fetch(new Request("https://api.test/api/v1/track/visitor", { method: "DELETE", headers: { Origin: MKT, "Content-Type": "application/json" }, body: JSON.stringify({ visitorId: id }) }), h.env, { waitUntil() {}, passThroughOnException() {} } as any);
  assert.equal(del.status, 200); assert.equal(((await del.json()) as any).erased, 1);
  assert.equal(await row(id), undefined);

  await visit({ consent: true, visitorId: old }); await visit({ consent: true, visitorId: fresh });
  await h.admin`update visitors set last_seen = now() - interval '91 days' where visitor_id = ${old}`;
  const { getDb } = await import("../src/db.ts"); const sql = getDb(h.env);
  try { assert.ok((await purgeOldVisitors(sql, 90)) >= 1); } finally { await sql.end(); }
  assert.equal(await row(old), undefined); assert.ok(await row(fresh));
});

test("CORS: marketing origin may call /track (no credentials); it gets nothing on the authenticated API; strangers get nothing", { skip }, async () => {
  const pre = (path: string, origin: string) => app.fetch(new Request(`https://api.test${path}`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } }), h.env, { waitUntil() {}, passThroughOnException() {} } as any);
  const ok = await pre("/api/v1/track/visit", MKT);
  assert.equal(ok.headers.get("access-control-allow-origin"), MKT);
  assert.equal(ok.headers.get("access-control-allow-credentials"), null);
  assert.equal((await pre("/api/v1/track/visit", "https://evil.example")).headers.get("access-control-allow-origin"), null);
  assert.equal((await pre("/api/v1/documents", MKT)).headers.get("access-control-allow-origin"), null, "marketing origin must not reach the authenticated API");
  assert.equal((await pre("/api/v1/documents", APP)).headers.get("access-control-allow-credentials"), "true");
});

test("a database outage never breaks the page: still 202, counted:false", { skip }, async () => {
  const broken = { ...h.env, HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/none" } };
  const res = await visit({ consent: true, visitorId: uuid() }, MKT, CHROME, "203.0.113.9", broken);
  assert.equal(res.status, 202);
  assert.equal(((await res.json()) as any).counted, false);
});

test("admin summary: platform admins get aggregates (no ids/IPs); ordinary tenants are refused", { skip }, async () => {
  await h.admin`delete from visitors`;
  await visit({ consent: true, visitorId: uuid() }); await visit({ consent: true, visitorId: uuid() }, APP);
  const t = await h.newTenant("vis"); const a = await h.newTenant("visadmin");
  await h.admin`insert into tenants (tenant_id, business_name, owner_email, is_platform_admin) values (${a.tenantId}, 'Admin', ${a.email}, true) on conflict (tenant_id) do update set is_platform_admin = true`;
  assert.equal((await h.call(t.token, "GET", "/api/v1/admin/visitors/summary")).status, 403);
  const r = await h.call(a.token, "GET", "/api/v1/admin/visitors/summary?days=30");
  assert.equal(r.status, 200, r.text);
  const sites = Object.fromEntries(r.json.bySite.map((s: any) => [s.site, s.uniqueVisitors]));
  assert.deepEqual(sites, { app: 1, marketing: 1 });
  assert.ok(!/visitor_id|last_ip|203\.0\.113/.test(r.text), "summary must be aggregates only");
});
