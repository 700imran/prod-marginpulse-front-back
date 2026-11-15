// Regression: the daily cron sweep threw `date/time field value out of range: "0000-01-01"` on real Postgres
// for every tenant that had at least one vendor (found by the cron_run{outcome="tenant_error"} metric during
// the live observability check). Needs TEST_DATABASE_URL.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { getDb } from "../src/db.ts";
import { detectMissingInvoices } from "../src/pipelines/missingInvoice.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
const keepAlive = setInterval(() => {}, 1000);
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

test("detectMissingInvoices runs on real Postgres and flags an old unmatched debit that looks like a vendor payment", { skip }, async () => {
  const t = await h.newTenant("missing-inv");
  await h.admin`insert into documents (tenant_id, original_filename, storage_key, mime_type, vendor_name)
                values (${t.tenantId}, 'a.pdf', ${"k/" + t.tenantId}, 'application/pdf', 'Acme Traders Pvt Ltd')`;
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount)
                values (${t.tenantId}, 'NEFT ACME TRADERS PVT LTD', ${ago(30)}, 11800)`;
  // too recent (still waiting on OCR/reconciliation) and a credit: neither may be flagged
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount)
                values (${t.tenantId}, 'NEFT ACME TRADERS PVT LTD', ${ago(1)}, 500)`;
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, credit_amount)
                values (${t.tenantId}, 'NEFT ACME TRADERS PVT LTD', ${ago(40)}, 900)`;
  // an ancient row must still be scanned (the lower bound has to be a real, very early date)
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount)
                values (${t.tenantId}, 'something unrelated xyz', '1999-01-01', 10)`;

  const sql = getDb(h.env);
  try {
    const r = await detectMissingInvoices(sql, t.tenantId);
    assert.equal(r.anomaliesCreated, 1);
    assert.equal(r.bankTransactionsScanned, 3, "old debit + old credit + 1999 row are in range; the 1-day-old one is not");
    const again = await detectMissingInvoices(sql, t.tenantId);
    assert.equal(again.anomaliesCreated, 0, "a second sweep must not duplicate the open anomaly");
  } finally { await sql.end(); }
  const [{ n }] = await h.admin<{ n: string }[]>`select count(*)::text as n from anomalies where tenant_id = ${t.tenantId} and anomaly_type = 'MISSING_INVOICE'`;
  assert.equal(n, "1");
});

test("a tenant with no vendors short-circuits without touching the date range", { skip }, async () => {
  const t = await h.newTenant("missing-inv-none");
  const sql = getDb(h.env);
  try { assert.deepEqual(await detectMissingInvoices(sql, t.tenantId), { bankTransactionsScanned: 0, anomaliesCreated: 0 }); }
  finally { await sql.end(); }
});

// ── daily cron fan-out (was: first 1000 tenants, sequentially, inside one invocation) ──
import worker from "../src/index.ts";
import { listMissingInvoiceCandidateTenants } from "../src/repository/bankTransactions.ts";

async function seedCandidate(label: string) {
  const t = await h.newTenant(label);
  await h.admin`insert into tenants (tenant_id, owner_email, business_name) values (${t.tenantId}, ${t.email}, ${label}) on conflict (tenant_id) do nothing`;
  await h.admin`insert into documents (tenant_id, original_filename, storage_key, mime_type, vendor_name) values (${t.tenantId}, 'a.pdf', ${"k/" + t.tenantId}, 'application/pdf', 'Zenith Steel Works')`;
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount) values (${t.tenantId}, 'NEFT ZENITH STEEL WORKS', ${ago(20)}, 9000)`;
  return t;
}

test("cron fans out ONE queue message per tenant that has work (not per tenant ever created), and the consumer then creates the anomalies", { skip }, async () => {
  const withWork = [await seedCandidate("cron-a"), await seedCandidate("cron-b"), await seedCandidate("cron-c")];
  const idle = await h.newTenant("cron-idle"); // no vendors, no bank rows → must not be enqueued
  await h.admin`insert into tenants (tenant_id, owner_email, business_name) values (${idle.tenantId}, ${idle.email}, 'idle') on conflict (tenant_id) do nothing`;
  const recent = await h.newTenant("cron-recent"); // vendor on file but the only debit is too recent
  await h.admin`insert into tenants (tenant_id, owner_email, business_name) values (${recent.tenantId}, ${recent.email}, 'recent') on conflict (tenant_id) do nothing`;
  await h.admin`insert into documents (tenant_id, original_filename, storage_key, mime_type, vendor_name) values (${recent.tenantId}, 'a.pdf', ${"k/" + recent.tenantId}, 'application/pdf', 'Zenith Steel Works')`;
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount) values (${recent.tenantId}, 'NEFT ZENITH STEEL WORKS', ${ago(1)}, 100)`;

  h.queues.RECONCILE_QUEUE.pending.length = 0;
  await worker.scheduled({} as any, h.env, { waitUntil() {} } as any);
  const msgs = h.queues.RECONCILE_QUEUE.pending.filter((m: any) => m.task === "detect_missing_invoices") as any[];
  const ids = new Set(msgs.map((m) => m.args.tenant_id));
  for (const t of withWork) assert.ok(ids.has(t.tenantId), "tenant with work is enqueued");
  assert.ok(!ids.has(idle.tenantId) && !ids.has(recent.tenantId), "tenants without work are not enqueued");
  assert.equal(ids.size, msgs.length, "exactly one message per tenant");

  await h.drain();
  for (const t of withWork) {
    const [{ n }] = await h.admin<{ n: string }[]>`select count(*)::text as n from anomalies where tenant_id = ${t.tenantId} and anomaly_type = 'MISSING_INVOICE'`;
    assert.equal(n, "1", "consumer created the anomaly");
  }
  // running the cron again changes nothing (idempotent)
  await worker.scheduled({} as any, h.env, { waitUntil() {} } as any);
  await h.drain();
  for (const t of withWork) {
    const [{ n }] = await h.admin<{ n: string }[]>`select count(*)::text as n from anomalies where tenant_id = ${t.tenantId} and anomaly_type = 'MISSING_INVOICE'`;
    assert.equal(n, "1", "no duplicate anomaly on the second run");
  }
});

test("candidate-tenant query is keyset-paginated: pages never repeat or skip, regardless of page size", { skip }, async () => {
  for (let i = 0; i < 5; i++) await seedCandidate(`page-${i}`);
  const all = await listMissingInvoiceCandidateTenants(getDb(h.env), ago(5), null, 100000);
  const paged: string[] = []; let after: string | null = null;
  const sql = getDb(h.env);
  try {
    for (;;) { const p = await listMissingInvoiceCandidateTenants(sql, ago(5), after, 2); if (!p.length) break; paged.push(...p); after = p[p.length - 1]!; }
  } finally { await sql.end(); }
  assert.deepEqual(paged, all);
  assert.equal(new Set(paged).size, paged.length);
  assert.ok(paged.length >= 5);
});
