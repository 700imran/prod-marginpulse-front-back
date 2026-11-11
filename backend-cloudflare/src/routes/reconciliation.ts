import { emit } from "../observability/events";
import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { buildDashboardSummary, buildBusinessInsights } from "../pipelines/dashboard";
import { detectMissingInvoices } from "../pipelines/missingInvoice";
import { countDocumentsByStatus, bulkInsertDatasetDocuments, listExistingInvoiceKeys } from "../repository/documents";
import { buildReportCsv } from "../pipelines/exportReport";
import { makeInvoiceDeduper, bankKey } from "../pipelines/dedupe";
import { listAnomalies, getAnomalyById, resolveAnomaly } from "../repository/anomalies";
import { appendAuditLog } from "../repository/auditLog";
import { bulkInsertBankTransactions, type NewBankTransaction } from "../repository/bankTransactions";
import { normaliseDataset, normaliseWorkbook, type DatasetType } from "../pipelines/dataset";
import { reconcileTenant } from "../pipelines/tenantReconcile";

export const reconciliationRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

reconciliationRoutes.use("*", requireAuth);

// GET /reconciliation/dashboard-summary — mirrors HandleDashboardSummary.
reconciliationRoutes.get("/dashboard-summary", async (c) => {
  const summary = await buildDashboardSummary(c.get("sql"), c.env, c.get("tenant").tenantId);
  return c.json(summary);
});

// GET /reconciliation/dashboard-insights — mirrors HandleDashboardInsights.
reconciliationRoutes.get("/dashboard-insights", async (c) => {
  const insights = await buildBusinessInsights(c.get("sql"), c.get("tenant").tenantId);
  return c.json(insights);
});

// POST /reconciliation/run — re-queues every PARSED document for another reconciliation pass.
// ONE queue message per tenant (the consumer does a single global one-to-one pass). It used to enqueue one message per
// document, so a 3,000-invoice backlog meant 3,000 messages and 3,000 independent database round-trip chains.
reconciliationRoutes.post("/run", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const sql = c.get("sql");
  const pending = await countDocumentsByStatus(sql, tenantId, "PARSED");
  const jobId = crypto.randomUUID();
  if (pending === 0) return c.json({ job_id: jobId, documents_queued: 0 });
  try {
    await c.env.RECONCILE_QUEUE.send({ task: "reconcile_tenant", job_id: jobId, args: { tenant_id: tenantId } });
  } catch (e) {
    // Queue unavailable: do the work inline rather than silently dropping the request.
    console.error("reconcile_enqueue_failed", { error: (e as Error).message });
    await reconcileTenant(sql, tenantId);
  }
  return c.json({ job_id: jobId, documents_queued: pending });
});

reconciliationRoutes.get("/anomalies", async (c) => {
  const q = c.req.query();
  const items = await listAnomalies(c.get("sql"), c.get("tenant").tenantId, q.status, parseInt(q.limit ?? "100", 10), parseInt(q.offset ?? "0", 10));
  return c.json({ items });
});

reconciliationRoutes.post("/anomaly/:id/resolve", async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const anomalyId = c.req.param("id");
  const existing = await getAnomalyById(sql, tenant.tenantId, anomalyId);
  if (!existing) return c.json({ error: "anomaly not found" }, 404);

  await resolveAnomaly(sql, tenant.tenantId, anomalyId, "RESOLVED", tenant.ownerEmail);
  await appendAuditLog(sql, { tenantId: tenant.tenantId, entityType: "ANOMALY", entityId: anomalyId, action: "ANOMALY_RESOLVED", actorEmail: tenant.ownerEmail });
  const resolved = await getAnomalyById(sql, tenant.tenantId, anomalyId);
  return c.json(resolved);
});

// GET /reconciliation/export — CSV audit / reconciliation report of every document (keyset-paginated reads,
// formula-injection safe, tenant-scoped). Mirrors HandleExportReconciliationReport.
reconciliationRoutes.get("/export", async (c) => {
  const { csv, rows, truncated } = await buildReportCsv(c.get("sql"), c.get("tenant").tenantId);
  const today = new Date().toISOString().slice(0, 10);
  emit("report_export", { truncated: String(truncated) }, rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="reconciliation-report-${today}.csv"`,
      "Cache-Control": "no-store", "X-Report-Rows": String(rows), ...(truncated ? { "X-Report-Truncated": "true" } : {}),
    },
  });
});

// POST /reconciliation/detect-missing-invoices — on-demand trigger,
// mirrors HandleDetectMissingInvoices. wrangler.toml's daily cron
// trigger calls this same pipeline function across all tenants (see
// src/index.ts's scheduled() handler) — this route is for an
// on-demand run from the UI.
reconciliationRoutes.post("/detect-missing-invoices", async (c) => {
  const result = await detectMissingInvoices(c.get("sql"), c.get("tenant").tenantId);
  return c.json({ bank_transactions_scanned: result.bankTransactionsScanned, anomalies_created: result.anomaliesCreated });
});

// POST /reconciliation/bank-csv-upload — mirrors HandleBankCSVUpload,
// same tolerant header-matching for Indian bank statement exports.
reconciliationRoutes.post("/bank-csv-upload", async (c) => {
  const bankName = c.req.query("bank_name") ?? "";
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no CSV file provided" }, 400);

  const text = await file.text();
  const rows = parseBankCSV(text);
  if (rows.length === 0) return c.json({ error: "CSV file contains no valid transaction rows" }, 400);

  const tenantId = c.get("tenant").tenantId;
  const inserts: NewBankTransaction[] = rows.map((r) => ({
    tenantId, narration: r.narration, transactionDate: r.date, debitAmount: r.debit, creditAmount: r.credit,
    bankName, sourceFilename: file.name,
  }));
  const created = await bulkInsertBankTransactions(c.get("sql"), inserts);

  return c.json({ transactions_created: created, rows_in_file: rows.length, bank_name: bankName });
});


// POST /reconciliation/dataset-upload — format-agnostic ingestion. The browser parses CSV / TSV / XLSX / JSON / XML / TXT
// into a row grid (or one grid per sheet) and posts it here; the header row(s), column mapping, dataset type, dates and
// amounts are all detected by pipelines/dataset.ts.
const MAX_DATASET_ROWS = 20000;
reconciliationRoutes.post("/dataset-upload", rateLimit("dataset", 20, 60), async (c) => {
  let body: { fileName?: string; bankName?: string; datasetType?: string; rows?: unknown; sheets?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const forced = ["BANK_STATEMENT", "INVOICE_REGISTER", "GST_RETURN"].includes(body.datasetType ?? "") ? (body.datasetType as DatasetType) : undefined;

  let sheets: { name: string; rows: unknown[][] }[];
  if (Array.isArray(body.sheets) && body.sheets.length > 0) {
    if (body.sheets.length > 40) return c.json({ error: "Too many sheets (limit 40)." }, 413);
    sheets = (body.sheets as { name?: unknown; rows?: unknown }[]).filter((s) => s && Array.isArray(s.rows) && s.rows.length > 0)
      .map((s, i) => ({ name: String(s.name ?? `Sheet${i + 1}`).slice(0, 60), rows: (s.rows as unknown[]).filter(Array.isArray) as unknown[][] }));
  } else {
    if (!Array.isArray(body.rows) || body.rows.length === 0) return c.json({ error: "rows must be a non-empty array" }, 400);
    sheets = [{ name: "Sheet1", rows: (body.rows as unknown[]).filter(Array.isArray) as unknown[][] }];
  }
  if (sheets.length === 0) return c.json({ error: "rows must be a non-empty array" }, 400);
  const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (totalRows > MAX_DATASET_ROWS + 50) return c.json({ error: `File has too many rows (limit ${MAX_DATASET_ROWS.toLocaleString("en-IN")}). Split it by quarter and upload the parts.` }, 413);

  const data = normaliseWorkbook(sheets, forced);
  if (!data) return c.json({ error: "Could not find a header row. Expected columns like Date, Narration/Description, Debit/Credit or Invoice No, Party, Amount." }, 422);
  if (data.bank.length + data.invoices.length === 0) return c.json({ error: data.warnings.join(" ") || "No usable rows found" }, 422);
  if (data.datasetType === "GENERIC") return c.json({ error: data.warnings[0] }, 422);
  // A customer-side register would be stored as payables: it would inflate ITC-at-risk and compete with real vendor
  // invoices for bank payments. Customer-receipt reconciliation does not exist yet, so refuse clearly instead of
  // importing it with a footnote. (An explicit datasetType from the caller is respected.)
  if (data.salesRegister && !forced) return c.json({ error: "This looks like a SALES / receivables register (customer invoices). Customer receipts are not reconciled yet, so it was not imported. Upload your purchase register, GSTR-2B or GSTR-2A for payables reconciliation." }, 422);

  const tenantId = c.get("tenant").tenantId;
  const sql = c.get("sql");
  const fileName = (body.fileName ?? "upload").slice(0, 200);
  let created = 0, duplicates = 0;

  if (data.datasetType === "BANK_STATEMENT") {
    const dates = data.bank.map((r) => r.date).sort();
    const existing = await sql<{ d: string; n: string; db: string; cr: string }[]>`
      select transaction_date::text as d, coalesce(narration,'') as n, debit_amount::text as db, credit_amount::text as cr
      from bank_transactions where tenant_id = ${tenantId} and transaction_date between ${dates[0]!} and ${dates[dates.length - 1]!}`;
    const seen = new Map<string, number>(existing.map((e) => bankKey({ date: e.d, narration: e.n, debit: parseFloat(e.db), credit: parseFloat(e.cr) })).reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>()));
    // Two genuinely identical rows in ONE file (e.g. two ₹500 UPI payments to the same payee on a day) are both kept;
    // a row is a duplicate only if the database already holds at least as many copies as the file has seen so far.
    const inFile = new Map<string, number>();
    const fresh = data.bank.filter((r) => {
      const k = bankKey(r);
      const n = (inFile.get(k) ?? 0) + 1; inFile.set(k, n);
      return n > (seen.get(k) ?? 0);
    });
    duplicates = data.bank.length - fresh.length;
    created = await bulkInsertBankTransactions(sql, fresh.map((r) => ({
      tenantId, narration: r.narration, transactionDate: r.date, debitAmount: r.debit, creditAmount: r.credit,
      bankReference: r.reference, bankName: body.bankName ?? "", sourceFilename: fileName,
    })));
    if (duplicates > 0) data.warnings.push(`${duplicates} duplicate transaction(s) already on file were skipped.`);
  } else {
    const dates = data.invoices.map((r) => r.date).sort();
    const existing = await listExistingInvoiceKeys(sql, tenantId, dates[0]!, dates[dates.length - 1]!);
    const dedupe = makeInvoiceDeduper(existing.map((e) => ({ vendor: e.vendorName ?? "", invoiceNo: e.invoiceNumber ?? "", total: parseFloat(e.rawTotalAmount ?? "0") || 0, date: e.documentDate ?? "", gstin: e.taxIdentifier ?? "", docType: e.docType === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE" })));
    const fresh = data.invoices.filter((r) => !dedupe.seen({ vendor: r.vendor, invoiceNo: r.invoiceNo, total: r.total, date: r.date, gstin: r.gstin, docType: r.docType === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE" }));
    duplicates = data.invoices.length - fresh.length;
    created = await bulkInsertDatasetDocuments(sql, fresh.map((r) => ({
      tenantId, docType: r.docType, originalFilename: fileName, vendorName: r.vendor || null, documentDate: r.date, invoiceNumber: r.invoiceNo || null,
      rawTotalAmount: r.total, taxAmount: r.tax || null, taxIdentifier: r.gstin || null,
    })));
    if (duplicates > 0) data.warnings.push(`${duplicates} invoice(s) already on file (same invoice number and amount) were skipped.`);
  }

  const outcome = await reconcileTenant(sql, tenantId);
  emit("dataset_upload", { type: data.datasetType.toLowerCase() });
  emit("dataset_rows_imported", { type: data.datasetType.toLowerCase() }, created);
  await appendAuditLog(sql, { tenantId, entityType: "DATASET", entityId: crypto.randomUUID(), action: "DATASET_UPLOADED", reason: `${fileName} — ${data.datasetType}: ${created} rows`, actorEmail: c.get("tenant").ownerEmail });
  return c.json({ datasetType: data.datasetType, rowsRead: data.rowsRead, rowsImported: created, rowsSkipped: data.rowsSkipped, duplicatesSkipped: duplicates, warnings: data.warnings, reconciliation: outcome }, 201);
});

// --- CSV parsing helpers, exact port of the Go handler's tolerant parser ---

interface BankCSVRow {
  date: string; // ISO YYYY-MM-DD
  narration: string;
  debit: number;
  credit: number;
}

const DATE_FORMATS: ((s: string) => string | null)[] = [
  (s) => { const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }, // DD/MM/YYYY
  (s) => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? s : null; }, // ISO
  (s) => { const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }, // DD-MM-YYYY
  (s) => { const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null; },
];

function parseCSVDate(raw: string): string | null {
  const s = raw.trim();
  for (const fmt of DATE_FORMATS) {
    const parsed = fmt(s);
    if (parsed) return parsed;
  }
  return null;
}

function parseAmount(raw: string): number {
  let s = raw.trim().replace(/,/g, "").replace(/^₹/, "").trim();
  if (s === "" || s === "-") return 0;
  const v = parseFloat(s);
  return Number.isNaN(v) ? 0 : v;
}

function splitCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseBankCSV(text: string): BankCSVRow[] {
  const lines = text.split(/\r?\n/);
  let dateIdx = -1, narrationIdx = -1, debitIdx = -1, creditIdx = -1;
  const rows: BankCSVRow[] = [];

  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const cols = splitCSVLine(line);
    if (i === 0) {
      cols.forEach((col, idx) => {
        const c = col.trim().toLowerCase();
        if (dateIdx === -1 && ["date", "txn date", "transaction date", "value date"].includes(c)) dateIdx = idx;
        else if (narrationIdx === -1 && ["narration", "description", "particulars", "remarks"].includes(c)) narrationIdx = idx;
        else if (debitIdx === -1 && ["debit", "withdrawal", "debit amount", "withdrawal amt"].includes(c)) debitIdx = idx;
        else if (creditIdx === -1 && ["credit", "deposit", "credit amount", "deposit amt"].includes(c)) creditIdx = idx;
      });
      return;
    }
    if (dateIdx === -1 || narrationIdx === -1) return;
    if (dateIdx >= cols.length || narrationIdx >= cols.length) return;

    const date = parseCSVDate(cols[dateIdx]!);
    if (!date) return;

    const debit = debitIdx !== -1 && debitIdx < cols.length ? parseAmount(cols[debitIdx]!) : 0;
    const credit = creditIdx !== -1 && creditIdx < cols.length ? parseAmount(cols[creditIdx]!) : 0;
    if (debit === 0 && credit === 0) return;

    rows.push({ date, narration: cols[narrationIdx]!.trim(), debit, credit });
  });
  return rows;
}
