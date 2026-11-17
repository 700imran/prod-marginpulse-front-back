// Queue tasks are at-least-once: a message can be retried after a partial failure, and several documents of one tenant are
// reconciled concurrently (parallel uploads / queue consumers). These must not create duplicate alerts or let two documents
// claim the same bank row. Needs TEST_DATABASE_URL.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { getDb } from "../src/db.ts";
import { runReconciliation, finalizeOcrResult } from "../src/queue/consumer.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
const keepAlive = setInterval(() => {}, 1000);
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
async function doc(tenantId: string, o: { vendor?: string; invoice?: string | null; amount?: number; date?: string } = {}) {
  const [r] = await h.admin<{ id: string }[]>`insert into documents (tenant_id, original_filename, storage_key, mime_type, vendor_name, invoice_number, raw_total_amount, document_date, processing_status, ocr_confidence_score)
    values (${tenantId}, 'a.pdf', ${"k/" + crypto.randomUUID()}, 'application/pdf', ${o.vendor ?? "Acme Traders Pvt Ltd"}, ${o.invoice === undefined ? "INV-" + Math.floor(Math.random() * 1e9) : o.invoice}, ${o.amount ?? 11800}, ${o.date ?? day(10)}, 'PARSED', 0.95) returning document_id as id`;
  return r!.id;
}
const openAnomalies = (tenantId: string, type: string) => h.admin<{ n: string }[]>`select count(*)::text as n from anomalies where tenant_id = ${tenantId} and anomaly_type = ${type} and status = 'OPEN'`.then((r) => Number(r[0]!.n));

test("re-running reconciliation for the same document does not pile up duplicate UNMATCHED alerts", { skip }, async () => {
  const t = await h.newTenant("idem-unmatched");
  const id = await doc(t.tenantId);
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount) values (${t.tenantId}, 'UPI SOMEONE ELSE', ${day(10)}, 55)`; // a statement exists, but nothing matches
  for (let i = 0; i < 3; i++) await runReconciliation(h.env, null, { document_id: id, tenant_id: t.tenantId });
  assert.equal(await openAnomalies(t.tenantId, "RECONCILIATION_UNMATCHED"), 1, "one open alert, however many times the task ran");
});

test("a retried OCR task does not record the same duplicate-invoice alert (or audit entry) twice", { skip }, async () => {
  const t = await h.newTenant("idem-dup");
  await doc(t.tenantId, { vendor: "Globex Corp", invoice: "G-100", amount: 500 });
  const second = await doc(t.tenantId, { vendor: "Globex Corp", invoice: "G-100", amount: 500 });
  const sql = getDb(h.env);
  try {
    const ocr = { ocrAvailable: true, vendorName: "Globex Corp", documentDate: day(10), rawTotalAmount: 500, taxAmount: 0, taxIdentifier: "", invoiceNumber: "G-100", rawText: "", confidence: 0.9 };
    await finalizeOcrResult(h.env, sql, t.tenantId, second, ocr);
    await finalizeOcrResult(h.env, sql, t.tenantId, second, ocr); // the retry
  } finally { await sql.end(); }
  assert.equal(await openAnomalies(t.tenantId, "DUPLICATE_INVOICE"), 1);
  const [{ n }] = await h.admin<{ n: string }[]>`select count(*)::text as n from audit_log where tenant_id = ${t.tenantId} and entity_id = ${second} and action = 'DUPLICATE_DETECTED'`;
  assert.equal(n, "1");
});

test("two identical invoices reconciled at the same moment cannot both claim the one matching bank row", { skip }, async () => {
  for (let round = 0; round < 8; round++) {
    const t = await h.newTenant("idem-race");
    const a = await doc(t.tenantId, { invoice: "R-1" }), b = await doc(t.tenantId, { invoice: "R-2" }); // same vendor, amount and date (a recurring bill)
    await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount) values (${t.tenantId}, 'NEFT ACME TRADERS PVT LTD', ${day(10)}, 11800)`;
    await Promise.all([a, b].map((id) => runReconciliation(h.env, null, { document_id: id, tenant_id: t.tenantId })));
    const docs = await h.admin<{ id: string; s: string; m: string | null }[]>`select document_id as id, processing_status as s, matched_bank_transaction_id as m from documents where tenant_id = ${t.tenantId}`;
    const [bank] = await h.admin<{ s: string; d: string | null }[]>`select reconciliation_status as s, matched_document_id as d from bank_transactions where tenant_id = ${t.tenantId}`;
    const reconciled = docs.filter((d) => d.s === "RECONCILED");
    assert.equal(reconciled.length, 1, `round ${round}: exactly one document may be RECONCILED, got ${JSON.stringify(docs)}`);
    assert.equal(bank!.s, "MATCHED");
    assert.equal(bank!.d, reconciled[0]!.id, "the bank row points at the document that was reconciled to it");
    assert.equal(docs.filter((d) => d.m !== null).length, 1, "only the winner references the bank row");
  }
});

test("retrying reconciliation after it already succeeded keeps the match (idempotent)", { skip }, async () => {
  const t = await h.newTenant("idem-retry");
  const a = await doc(t.tenantId);
  await h.admin`insert into bank_transactions (tenant_id, narration, transaction_date, debit_amount) values (${t.tenantId}, 'NEFT ACME TRADERS PVT LTD', ${day(10)}, 11800)`;
  await runReconciliation(h.env, null, { document_id: a, tenant_id: t.tenantId });
  const [before1] = await h.admin<{ s: string; m: string | null }[]>`select processing_status as s, matched_bank_transaction_id as m from documents where document_id = ${a}`;
  assert.equal(before1!.s, "RECONCILED");
  await runReconciliation(h.env, null, { document_id: a, tenant_id: t.tenantId }); // queue redelivery
  const [after1] = await h.admin<{ s: string; m: string | null }[]>`select processing_status as s, matched_bank_transaction_id as m from documents where document_id = ${a}`;
  assert.deepEqual(after1, before1, "a redelivered task must not undo a completed match");
});
