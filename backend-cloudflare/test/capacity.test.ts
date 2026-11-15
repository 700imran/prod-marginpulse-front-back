// Capacity controls: DB-overload → 503 (not 500), load shedding of heavy endpoints, free-plan quotas, and a
// concurrent "storm" against the real app + real Postgres. See docs/CAPACITY.md for what this does NOT prove.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { makeLedger, INVOICE_LAYOUTS, BANK_LAYOUTS } from "./helpers/corpus.ts";
import { isDbUnavailable, retryAfterSeconds } from "../src/lib/dbErrors.ts";
import { shedHeavy, heavyLimit, _inflightForTests } from "../src/middleware/shed.ts";
import { limitsFor, DEFAULT_FREE_DOCS_PER_MONTH, DEFAULT_FREE_BANK_ROWS_PER_MONTH } from "../src/billing/limits.ts";
import { app } from "../src/index.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
const keepAlive = setInterval(() => {}, 1000);
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });
const U = "/api/v1/reconciliation/dataset-upload";

test("isDbUnavailable: overload/connection errors are retryable; ordinary bugs and constraint errors are not", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "53300", "57P03", "40P01"]) assert.equal(isDbUnavailable({ code }), true, code);
  assert.equal(isDbUnavailable(new Error("sorry, too many clients already")), true);
  assert.equal(isDbUnavailable(Object.assign(new Error("agg"), { errors: [{ code: "ECONNREFUSED" }] })), true);
  assert.equal(isDbUnavailable(Object.assign(new Error("wrapped"), { cause: { code: "ETIMEDOUT" } })), true);
  for (const e of [new Error("boom"), { code: "23505" }, { code: "42P01" }, null, undefined, "str", new TypeError("x is undefined")]) assert.equal(isDbUnavailable(e), false);
  for (let i = 0; i < 200; i++) { const s = retryAfterSeconds(); assert.ok(s >= 3 && s <= 6, String(s)); }
  assert.equal(retryAfterSeconds(2, 4, () => 0), 2);
});

test("limitsFor: only FREE is capped, defaults apply, env overrides, 0 = unlimited, junk falls back to defaults", () => {
  assert.deepEqual(limitsFor({}, "FREE"), { docsPerMonth: DEFAULT_FREE_DOCS_PER_MONTH, bankRowsPerMonth: DEFAULT_FREE_BANK_ROWS_PER_MONTH });
  assert.deepEqual(limitsFor({ FREE_DOCS_PER_MONTH: "10", FREE_BANK_ROWS_PER_MONTH: "0" }, "FREE"), { docsPerMonth: 10, bankRowsPerMonth: null });
  assert.deepEqual(limitsFor({ FREE_DOCS_PER_MONTH: "abc", FREE_BANK_ROWS_PER_MONTH: "-5" }, "FREE"), { docsPerMonth: DEFAULT_FREE_DOCS_PER_MONTH, bankRowsPerMonth: DEFAULT_FREE_BANK_ROWS_PER_MONTH });
  for (const t of ["STARTER", "GROWTH", "ENTERPRISE"]) assert.deepEqual(limitsFor({}, t), { docsPerMonth: null, bankRowsPerMonth: null });
});

test("shedHeavy: at the limit the excess gets an instant 503 + Retry-After, the rest finish, and the counter returns to zero", async () => {
  const a = new Hono<{ Bindings: any }>();
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  a.use("/slow", shedHeavy("t_slow"));
  a.get("/slow", async (c) => { await gate; return c.json({ ok: true }); });
  const env = { MAX_HEAVY_INFLIGHT: "2" };
  const calls = Array.from({ length: 6 }, () => Promise.resolve(a.fetch(new Request("https://x.test/slow"), env)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(_inflightForTests().t_slow, 2);
  release();
  const rs = await Promise.all(calls);
  const shed = rs.filter((r) => r.status === 503), ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 2); assert.equal(shed.length, 4);
  for (const r of shed) { assert.ok(Number(r.headers.get("Retry-After")) >= 2); const b: any = await r.json(); assert.equal(b.code, "BUSY"); assert.equal(b.retryable, true); }
  assert.equal(_inflightForTests().t_slow, 0, "counter must not leak");
  assert.equal((await a.fetch(new Request("https://x.test/slow"), { MAX_HEAVY_INFLIGHT: "0" })).status, 200, "0 switches shedding off");
  assert.equal(heavyLimit({}), 8);
});

test("shedHeavy releases its slot even when the handler throws", async () => {
  const a = new Hono<{ Bindings: any }>();
  a.use("/boom", shedHeavy("t_boom"));
  a.get("/boom", () => { throw new Error("x"); });
  for (let i = 0; i < 5; i++) await a.fetch(new Request("https://x.test/boom"), { MAX_HEAVY_INFLIGHT: "1" });
  assert.equal(_inflightForTests().t_boom, 0);
});

test("database down → authenticated calls answer 503 + Retry-After (retryable), not 500; nothing leaks", { skip }, async () => {
  const t = await h.newTenant("dbdown");
  const saved = h.env.HYPERDRIVE;
  h.env.HYPERDRIVE = { connectionString: "postgres://postgres:pg@127.0.0.1:1/none" };
  const real = console.error; console.error = () => {};
  try {
    const r = await h.call(t.token, "GET", "/api/v1/documents");
    assert.equal(r.status, 503, r.text);
    assert.ok(Number(r.headers.get("Retry-After")) >= 3);
    assert.equal(r.json.code, "BUSY"); assert.equal(r.json.retryable, true);
    assert.ok(!/127\.0\.0\.1|postgres/i.test(r.text), "no connection details in the body");
  } finally { console.error = real; h.env.HYPERDRIVE = saved; }
  assert.equal((await h.call(t.token, "GET", "/api/v1/documents")).status, 200, "recovers as soon as the database is back");
});

test("free plan: a dataset that would exceed the monthly bank-row cap is refused whole (402 PLAN_LIMIT); paid plans and the cap itself are respected", { skip }, async () => {
  const L = makeLedger({ n: 12, seed: 3, unpaid: 0, tds: 0, lateMax: 5, debitNotes: 0 });
  const bankRows = BANK_LAYOUTS[0]!.render(L.bank);
  const free = await h.newTenant("quota-free");
  h.env.FREE_BANK_ROWS_PER_MONTH = "5";
  try {
    const r = await h.call(free.token, "POST", U, { fileName: "b.csv", rows: bankRows, bankName: "HDFC" });
    assert.equal(r.status, 402, r.text);
    assert.equal(r.json.code, "PLAN_LIMIT"); assert.equal(r.json.resource, "bank_rows"); assert.equal(r.json.limit, 5); assert.equal(r.json.upgrade, true);
    assert.match(r.json.error, /Free plan/);
    const [{ n }] = await h.admin<{ n: string }[]>`select count(*)::text as n from bank_transactions where tenant_id = ${free.tenantId}`;
    assert.equal(n, "0", "a refused upload imports nothing, not even part of the file");

    const paid = await h.newTenant("quota-paid");
    await h.admin`update tenants set plan_tier = 'GROWTH' where tenant_id = ${paid.tenantId}`;
    const { invalidateTenantCache } = await import("../src/auth/supabase.ts"); invalidateTenantCache(paid.tenantId);
    const ok = await h.call(paid.token, "POST", U, { fileName: "b.csv", rows: bankRows, bankName: "HDFC" });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.rowsImported, L.bank.length);
  } finally { h.env.FREE_BANK_ROWS_PER_MONTH = "0"; }
});

test("free plan: document cap counts this month's documents, blocks the over-limit upload, and the single-file upload endpoint enforces it too", { skip }, async () => {
  const t = await h.newTenant("quota-docs");
  const L = makeLedger({ n: 6, seed: 5, unpaid: 0, tds: 0, lateMax: 5, debitNotes: 0 });
  h.env.FREE_DOCS_PER_MONTH = "4";
  try {
    const inv = await h.call(t.token, "POST", U, { fileName: "inv.csv", rows: INVOICE_LAYOUTS[0]!.render(L.invoices) });
    assert.equal(inv.status, 402, inv.text); // 6 > 4
    assert.equal(inv.json.resource, "documents");
    h.env.FREE_DOCS_PER_MONTH = "6";
    const ok = await h.call(t.token, "POST", U, { fileName: "inv.csv", rows: INVOICE_LAYOUTS[0]!.render(L.invoices) });
    assert.equal(ok.status, 201, ok.text);
    // at the cap now: a single-file upload is refused before anything is stored
    const fd = new FormData(); fd.append("file", new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n")], "x.pdf", { type: "application/pdf" })); fd.append("doc_type", "INVOICE");
    const res = await app.fetch(new Request("https://api.test/api/v1/documents/upload", { method: "POST", headers: { Authorization: `Bearer ${t.token}`, "CF-Connecting-IP": "10.9.9.9" }, body: fd }), h.env, { waitUntil() {}, passThroughOnException() {} } as any);
    assert.equal(res.status, 402, await res.clone().text());
    assert.equal(((await res.json()) as any).code, "PLAN_LIMIT");
    const [{ n }] = await h.admin<{ n: string }[]>`select count(*)::text as n from documents where tenant_id = ${t.tenantId}`;
    assert.equal(n, String(L.invoices.length), "nothing was stored for the refused upload");
  } finally { h.env.FREE_DOCS_PER_MONTH = "0"; }
});

test("STORM: 120 tenants import at once through a 15-slot shed → every answer is 201 or a retryable 503 (never 500), retries drain it, no tenant's data is lost, duplicated or crossed", { skip }, async () => {
  const N = 120;
  const tenants = await Promise.all(Array.from({ length: N }, (_, i) => h.newTenant(`storm${i}`)));
  const ledgers = tenants.map((_, i) => makeLedger({ n: 8 + (i % 5), seed: 100 + i, unpaid: 0, tds: 0, lateMax: 5, debitNotes: 0 }));
  h.env.MAX_HEAVY_INFLIGHT = "15";
  const stat = { first201: 0, first503: 0, other: [] as number[], retries: 0, retryAfterOk: true, ms: [] as number[] };
  try {
    await Promise.all(tenants.map(async (t, i) => {
      const rows = INVOICE_LAYOUTS[i % INVOICE_LAYOUTS.length]!.render(ledgers[i]!.invoices);
      for (let attempt = 0; attempt < 400; attempt++) { // a patient client: keeps retrying for ~a minute, as the app's backoff does
        const t0 = Date.now();
        const r = await h.call(t.token, "POST", U, { fileName: `s${i}.csv`, rows });
        stat.ms.push(Date.now() - t0);
        if (attempt === 0) r.status === 201 ? stat.first201++ : r.status === 503 ? stat.first503++ : stat.other.push(r.status);
        if (r.status === 201) return;
        if (r.status !== 503) { stat.other.push(r.status); return; }
        if (!(Number(r.headers.get("Retry-After")) >= 2) || r.json.code !== "BUSY") stat.retryAfterOk = false;
        stat.retries++;
        await new Promise((res) => setTimeout(res, 20 + Math.random() * 80)); // a client honouring Retry-After, jittered (time-compressed for the test)
      }
      stat.other.push(-1);
    }));
  } finally { h.env.MAX_HEAVY_INFLIGHT = "0"; }
  assert.deepEqual(stat.other, [], "no 500s, no gave-up clients");
  assert.ok(stat.first503 > 0, "the shed actually engaged under a burst of 120 simultaneous imports");
  assert.equal(stat.retryAfterOk, true);
  assert.equal(_inflightForTests().upload ?? 0, 0); assert.equal(_inflightForTests().dataset_upload, 0);
  const rows = await h.admin<{ tenant_id: string; n: string }[]>`select tenant_id, count(*)::text as n from documents where tenant_id = any(${tenants.map((t) => t.tenantId)}::uuid[]) group by 1`;
  const got = new Map(rows.map((r) => [r.tenant_id, Number(r.n)]));
  tenants.forEach((t, i) => assert.equal(got.get(t.tenantId), ledgers[i]!.invoices.length, `tenant ${i} must have exactly its own ${ledgers[i]!.invoices.length} invoices`));
  const sorted = [...stat.ms].sort((a, b) => a - b);
  console.log(`# storm: first-try 201=${stat.first201} 503=${stat.first503}; retries=${stat.retries}; request latency p50=${sorted[sorted.length >> 1]}ms p95=${sorted[Math.floor(sorted.length * 0.95)]}ms max=${sorted.at(-1)}ms`);
});
