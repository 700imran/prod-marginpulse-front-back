// Real Postgres + the real Hono app + the real queue consumer. Needs TEST_DATABASE_URL
// (CI provides a Postgres service; locally: TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:5432/mp npm test).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { makeLedger, BANK_LAYOUTS, INVOICE_LAYOUTS, r2 } from "./helpers/corpus.ts";
import { getDb } from "../src/db.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
// Held open so node:test's runner doesn't exit while AbortSignal.timeout timers (unref'd in Node) are pending.
const keepAlive = setInterval(() => {}, 1000);
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });

const U = "/api/v1/reconciliation/dataset-upload";
const upload = (token: string, rows: unknown[][], fileName: string, extra: object = {}) => h.call(token, "POST", U, { fileName, rows, ...extra });

test("DATE columns reach the app as YYYY-MM-DD strings (never JS Date objects)", { skip }, async () => {
  const sql = getDb(h.env);
  try {
    const [r] = await sql<{ d: unknown }[]>`select '2026-03-05'::date as d`;
    assert.equal(r!.d, "2026-03-05");
    // and a Date-typed JS value is serialised without a timezone shift
    const [r2_] = await sql<{ d: string }[]>`select ${new Date("2026-03-05T00:00:00Z") as any}::date::text as d`;
    assert.equal(r2_!.d, "2026-03-05");
  } finally { await sql.end(); }
});

test("bank statement + invoice register upload → every document matched to the right bank row (HDFC × GSTR-2B layouts)", { skip }, async () => {
  const t = await h.newTenant("e2e");
  const L = makeLedger({ n: 80, seed: 11, unpaid: 0.15, tds: 0.1, lateMax: 25, debitNotes: 0 });
  const bank = await upload(t.token, BANK_LAYOUTS[0]!.render(L.bank), "hdfc.csv", { bankName: "HDFC" });
  assert.equal(bank.status, 201, bank.text);
  assert.equal(bank.json.datasetType, "BANK_STATEMENT");
  assert.equal(bank.json.rowsImported, L.bank.length);
  const inv = await upload(t.token, INVOICE_LAYOUTS[0]!.render(L.invoices), "gstr2b.xlsx");
  assert.equal(inv.status, 201, inv.text);
  assert.equal(inv.json.rowsImported, L.invoices.length);

  const rows = await h.admin<{ no: string; status: string; narration: string | null; d: string | null; debit: string | null }[]>`
    select d.invoice_number as no, d.processing_status as status, b.narration, b.transaction_date::text as d, b.debit_amount::text as debit
    from documents d left join bank_transactions b on b.transaction_id = d.matched_bank_transaction_id where d.tenant_id = ${t.tenantId}`;
  const byNo = new Map(rows.map((r) => [r.no, r]));
  let auto = 0;
  for (const i of L.invoices) {
    const got = byNo.get(i.no)!; const truthId = L.truth.get(i.no);
    if (got.status === "RECONCILED") {
      auto++;
      const tb = L.bank.find((b) => b.id === truthId);
      assert.ok(tb, `${i.no} reconciled but it is unpaid in the ground truth`);
      assert.equal(got.narration, tb.narration, `${i.no} matched the wrong bank row`);
      assert.equal(got.d, tb.date);
      assert.equal(parseFloat(got.debit!), tb.debit);
    } else if (truthId === null) assert.equal(got.status, "PARSED");
  }
  const exactPaid = L.invoices.filter((i) => { const id = L.truth.get(i.no); const b = id ? L.bank.find((x) => x.id === id) : null; return b && Math.abs(b.debit - i.total) <= 1; }).length;
  assert.ok(auto >= exactPaid * 0.95, `only ${auto}/${exactPaid} exact payments auto-reconciled`);
  // the same bank row is never claimed twice
  const dup = await h.admin`select matched_bank_transaction_id from documents where tenant_id = ${t.tenantId} and matched_bank_transaction_id is not null group by 1 having count(*) > 1`;
  assert.equal(dup.length, 0);
  // bank rows flipped to MATCHED agree with the documents
  const matchedBank = await h.admin<{ n: string }[]>`select count(*)::text as n from bank_transactions where tenant_id = ${t.tenantId} and reconciliation_status = 'MATCHED'`;
  assert.equal(parseInt(matchedBank[0]!.n, 10), auto);
});

test("upload order does not matter: invoices first, then the bank statement, gives the same matches", { skip }, async () => {
  const t = await h.newTenant("order");
  const L = makeLedger({ n: 40, seed: 5, unpaid: 0.1, tds: 0, lateMax: 20 });
  assert.equal((await upload(t.token, INVOICE_LAYOUTS[2]!.render(L.invoices), "zoho.csv")).status, 201);
  const pending = await h.admin`select count(*)::int as n from documents where tenant_id = ${t.tenantId} and processing_status = 'RECONCILED'`;
  assert.equal(pending[0]!.n, 0);
  const b = await upload(t.token, BANK_LAYOUTS[3]!.render(L.bank), "axis.csv");
  assert.equal(b.status, 201, b.text);
  assert.ok(b.json.reconciliation.reconciled >= L.invoices.filter((i) => L.truth.get(i.no)).length * 0.9, JSON.stringify(b.json.reconciliation));
});

test("re-uploading the same files creates no duplicate bank rows or invoices", { skip }, async () => {
  const t = await h.newTenant("dedup");
  const L = makeLedger({ n: 30, seed: 21 });
  for (let k = 0; k < 2; k++) {
    assert.equal((await upload(t.token, BANK_LAYOUTS[1]!.render(L.bank), "sbi.csv")).status, k === 0 ? 201 : 201);
    assert.equal((await upload(t.token, INVOICE_LAYOUTS[1]!.render(L.invoices), "tally.csv")).status, 201);
  }
  const [{ b }] = await h.admin<{ b: number }[]>`select count(*)::int as b from bank_transactions where tenant_id = ${t.tenantId}`;
  const [{ d }] = await h.admin<{ d: number }[]>`select count(*)::int as d from documents where tenant_id = ${t.tenantId} and doc_type = 'INVOICE'`;
  assert.equal(b, L.bank.length);
  assert.equal(d, L.invoices.length);
});

test("5,000-row invoice register imports (stays under Postgres' bind-parameter limit)", { skip }, async () => {
  const t = await h.newTenant("big5k");
  const L = makeLedger({ n: 5000, seed: 3, unpaid: 0.3 });
  const t0 = Date.now();
  const res = await upload(t.token, INVOICE_LAYOUTS[2]!.render(L.invoices), "bills.csv");
  assert.equal(res.status, 201, res.text.slice(0, 300));
  assert.equal(res.json.rowsImported, 5000);
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
});

test("2,000 invoices × 2,667 bank rows reconcile quickly and correctly through the API", { skip }, async () => {
  const t = await h.newTenant("scale");
  const L = makeLedger({ n: 2000, seed: 99, unpaid: 0.1, tds: 0, lateMax: 30 });
  assert.equal((await upload(t.token, INVOICE_LAYOUTS[2]!.render(L.invoices), "bills.csv")).status, 201);
  const t0 = Date.now();
  const res = await upload(t.token, BANK_LAYOUTS[5]!.render(L.bank), "bank.csv");
  const ms = Date.now() - t0;
  assert.equal(res.status, 201, res.text.slice(0, 300));
  assert.ok(ms < 15_000, `bank upload + 2,000×2,667 reconcile took ${ms} ms`);
  const wrong = await h.admin<{ n: number }[]>`
    select count(*)::int as n from documents d join bank_transactions b on b.transaction_id = d.matched_bank_transaction_id
    where d.tenant_id = ${t.tenantId} and d.processing_status = 'RECONCILED' and abs(d.raw_total_amount - b.debit_amount) > 1`;
  assert.equal(wrong[0]!.n, 0);
  assert.ok(res.json.reconciliation.reconciled >= 1700, JSON.stringify(res.json.reconciliation));
});

test("POST /run enqueues ONE job (not one per document) and the consumer reconciles the backlog", { skip }, async () => {
  const t = await h.newTenant("run");
  const L = makeLedger({ n: 600, seed: 8, unpaid: 0, tds: 0, lateMax: 10 });
  assert.equal((await upload(t.token, INVOICE_LAYOUTS[2]!.render(L.invoices), "bills.csv")).status, 201);
  // load bank rows straight into the table so nothing has reconciled yet
  await h.admin`insert into bank_transactions ${h.admin(L.bank.filter((b) => b.debit > 0).map((b) => ({ tenant_id: t.tenantId, narration: b.narration, transaction_date: b.date, debit_amount: b.debit, credit_amount: 0 })))}`;
  h.queues.RECONCILE_QUEUE!.pending.length = 0; h.queues.RECONCILE_QUEUE!.sentTotal = 0;
  const run = await h.call(t.token, "POST", "/api/v1/reconciliation/run");
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.documents_queued, 600);
  assert.equal(h.queues.RECONCILE_QUEUE!.sentTotal, 1, "must be a single queue message, not one per document");
  const t0 = Date.now();
  const drained = await h.drain();
  assert.equal(drained.failed, 0);
  assert.ok(Date.now() - t0 < 10_000, `backlog took ${Date.now() - t0} ms`);
  const [{ n }] = await h.admin<{ n: number }[]>`select count(*)::int as n from documents where tenant_id = ${t.tenantId} and processing_status = 'RECONCILED'`;
  assert.ok(n >= 570, `${n}/600 reconciled`);
});

test("export: complete, paginated, formula-injection safe, tenant-scoped", { skip }, async () => {
  const t = await h.newTenant("export"); const other = await h.newTenant("other");
  const rows = Array.from({ length: 4500 }, (_, i) => ({ tenant_id: t.tenantId, original_filename: "x", storage_key: "", mime_type: "text/tabular", vendor_name: i === 0 ? "=HYPERLINK(\"http://evil\",\"x\")" : i === 1 ? "@SUM(A1)" : i === 2 ? "Quote, \"Co\"\nLine2" : `Vendor ${i}`, invoice_number: `N${i}`, raw_total_amount: 100 + i, document_date: "2026-04-01", processing_status: "PARSED" }));
  for (let k = 0; k < rows.length; k += 1000) await h.admin`insert into documents ${h.admin(rows.slice(k, k + 1000))}`;
  await h.admin`insert into documents ${h.admin([{ tenant_id: other.tenantId, original_filename: "secret", storage_key: "", mime_type: "x", vendor_name: "OTHER TENANT SECRET", processing_status: "PARSED" }])}`;
  const res = await h.call(t.token, "GET", "/api/v1/reconciliation/export");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.ok(!res.text.includes("OTHER TENANT SECRET"));
  assert.ok(res.text.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/m.test(res.text), "formula cells must be neutralised");
  assert.ok(res.text.includes("'@SUM"));
  assert.ok(res.text.includes('"Quote, ""Co""\nLine2"'), "RFC-4180 quoting");
  const ids = new Set([...res.text.matchAll(/^([0-9a-f]{8}-[0-9a-f-]{27}),/gm)].map((m) => m[1]));
  assert.equal(ids.size, 4500, "every document exactly once across all pages");
});

test("tenant isolation: another tenant's token cannot read or reconcile my documents", { skip }, async () => {
  const a = await h.newTenant("isoA"); const b = await h.newTenant("isoB");
  const L = makeLedger({ n: 10, seed: 2 });
  await upload(a.token, INVOICE_LAYOUTS[2]!.render(L.invoices), "a.csv");
  const docs = await h.call(b.token, "GET", "/api/v1/documents");
  assert.equal(docs.status, 200);
  assert.equal(JSON.stringify(docs.json).includes(L.invoices[0]!.no), false);
  const run = await h.call(b.token, "POST", "/api/v1/reconciliation/run");
  assert.equal(run.json.documents_queued, 0);
});

test("amount precision: paise survive the round trip exactly", { skip }, async () => {
  const t = await h.newTenant("paise");
  const grid = [["Invoice No", "Invoice Date", "Supplier Name", "Total"], ["P-1", "2026-04-01", "Paise Traders", "12345.67"], ["P-2", "2026-04-02", "Paise Traders", "0.01"], ["P-3", "2026-04-03", "Paise Traders", "99999999.99"]];
  assert.equal((await upload(t.token, grid, "p.csv")).status, 201);
  const got = await h.admin<{ no: string; amt: string }[]>`select invoice_number as no, raw_total_amount::text as amt from documents where tenant_id = ${t.tenantId} order by invoice_number`;
  assert.deepEqual(got.map((g) => g.amt), ["12345.67", "0.01", "99999999.99"]);
  assert.equal(r2(0.1 + 0.2), 0.3);
});
