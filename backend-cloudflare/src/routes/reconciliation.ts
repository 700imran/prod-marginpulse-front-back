import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { buildDashboardSummary, buildBusinessInsights } from "../pipelines/dashboard";
import { detectMissingInvoices } from "../pipelines/missingInvoice";
import { listByStatus, listAllForExport } from "../repository/documents";
import { listAnomalies, getAnomalyById, resolveAnomaly } from "../repository/anomalies";
import { appendAuditLog } from "../repository/auditLog";
import { bulkInsertBankTransactions, type NewBankTransaction } from "../repository/bankTransactions";
import { normaliseDataset, type DatasetType } from "../pipelines/dataset";
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

// POST /reconciliation/run — mirrors HandleRunReconciliation: re-queues
// every PARSED document for another reconciliation pass.
reconciliationRoutes.post("/run", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const docs = await listByStatus(c.get("sql"), tenantId, "PARSED");
  let queued = 0;
  for (const doc of docs) {
    try {
      await c.env.RECONCILE_QUEUE.send({ task: "run_reconciliation", job_id: crypto.randomUUID(), args: { tenant_id: tenantId, document_id: doc.documentId } });
      queued++;
    } catch {
      // one failed enqueue shouldn't block the rest — matches the Go handler's continue-on-error loop
    }
  }
  return c.json({ job_id: crypto.randomUUID(), documents_queued: queued });
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

// GET /reconciliation/export — CSV of every document, mirrors
// HandleExportReconciliationReport.
reconciliationRoutes.get("/export", async (c) => {
  const docs = await listAllForExport(c.get("sql"), c.get("tenant").tenantId);
  const header = [
    "document_id", "vendor_name", "invoice_number", "document_date", "raw_total_amount",
    "tax_amount", "tax_identifier", "processing_status", "ocr_confidence_score",
    "reconciliation_score", "matched_bank_transaction_id", "gst_portal_status",
    "exception_reason", "duplicate_of_document_id", "manually_corrected", "created_at",
  ];
  const csvEscape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const d of docs) {
    lines.push([
      d.documentId, d.vendorName, d.invoiceNumber, d.documentDate, d.rawTotalAmount,
      d.taxAmount, d.taxIdentifier, d.processingStatus, d.ocrConfidenceScore,
      d.reconciliationScore, d.matchedBankTransactionId, d.gstPortalStatus,
      d.reconciliationReason, d.duplicateOfDocumentId, d.manuallyCorrected, d.createdAt,
    ].map(csvEscape).join(","));
  }
  const today = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="reconciliation-report-${today}.csv"` },
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


// POST /reconciliation/dataset-upload — format-agnostic ingestion. The
// browser parses CSV / TSV / XLSX / JSON / XML / TXT into a row grid and
// posts it here; the header row, column mapping, dataset type, dates and
// amounts are all detected by pipelines/dataset.ts.
const MAX_DATASET_ROWS = 5000;
reconciliationRoutes.post("/dataset-upload", async (c) => {
  let body: { fileName?: string; bankName?: string; datasetType?: string; rows?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (!Array.isArray(body.rows) || body.rows.length === 0) return c.json({ error: "rows must be a non-empty array" }, 400);
  if (body.rows.length > MAX_DATASET_ROWS + 50) return c.json({ error: `File has too many rows (limit ${MAX_DATASET_ROWS}). Split it by month or quarter and upload the parts.` }, 413);
  const grid = (body.rows as unknown[]).filter(Array.isArray) as unknown[][];
  const forced = ["BANK_STATEMENT", "INVOICE_REGISTER", "GST_RETURN"].includes(body.datasetType ?? "") ? (body.datasetType as DatasetType) : undefined;
  const data = normaliseDataset(grid, forced);
  if (!data) return c.json({ error: "Could not find a header row. Expected columns like Date, Narration/Description, Debit/Credit or Invoice No, Party, Amount." }, 422);
  if (data.bank.length + data.invoices.length === 0) return c.json({ error: data.warnings.join(" ") || "No usable rows found" }, 422);
  if (data.datasetType === "GENERIC") return c.json({ error: data.warnings[0] }, 422);

  const tenantId = c.get("tenant").tenantId;
  const sql = c.get("sql");
  const fileName = (body.fileName ?? "upload").slice(0, 200);
  let created = 0;

  if (data.datasetType === "BANK_STATEMENT") {
    const dates = data.bank.map((r) => r.date).sort();
    const existing = await sql<{ d: string; n: string; db: string; cr: string }[]>`
      select transaction_date::text as d, coalesce(narration,'') as n, debit_amount::text as db, credit_amount::text as cr
      from bank_transactions where tenant_id = ${tenantId} and transaction_date between ${dates[0]!} and ${dates[dates.length - 1]!}`;
    const seen = new Set(existing.map((e) => `${e.d}|${e.n}|${parseFloat(e.db)}|${parseFloat(e.cr)}`));
    const fresh = data.bank.filter((r) => {
      const k = `${r.date}|${r.narration}|${r.debit}|${r.credit}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    created = await bulkInsertBankTransactions(sql, fresh.map((r) => ({
      tenantId, narration: r.narration, transactionDate: r.date, debitAmount: r.debit, creditAmount: r.credit,
      bankReference: r.reference, bankName: body.bankName ?? "", sourceFilename: fileName,
    })));
    data.warnings.push(...(fresh.length < data.bank.length ? [`${data.bank.length - fresh.length} duplicate transaction(s) already on file were skipped.`] : []));
  } else {
    const values = data.invoices.map((r) => ({
      tenant_id: tenantId, doc_type: "INVOICE", original_filename: fileName, storage_key: "", mime_type: "text/tabular", file_size_bytes: 0,
      vendor_name: r.vendor || null, document_date: r.date, invoice_number: r.invoiceNo || null, raw_total_amount: r.total, tax_amount: r.tax || null,
      tax_identifier: r.gstin || null, ingest_channel: "WEB_UPLOAD", processing_status: "PARSED", ocr_confidence_score: 1,
    }));
    await sql`insert into documents ${sql(values, "tenant_id", "doc_type", "original_filename", "storage_key", "mime_type", "file_size_bytes", "vendor_name", "document_date", "invoice_number", "raw_total_amount", "tax_amount", "tax_identifier", "ingest_channel", "processing_status", "ocr_confidence_score")}`;
    created = values.length;
  }

  const outcome = await reconcileTenant(sql, tenantId);
  await appendAuditLog(sql, { tenantId, entityType: "DATASET", entityId: fileName, action: "DATASET_UPLOADED", reason: `${data.datasetType}: ${created} rows`, actorEmail: c.get("tenant").ownerEmail });
  return c.json({ datasetType: data.datasetType, rowsRead: data.rowsRead, rowsImported: created, rowsSkipped: data.rowsSkipped, warnings: data.warnings, reconciliation: outcome }, 201);
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
