// Exact port of cmd/worker/main.go. One consumer Worker drains all 5
// Cloudflare Queues (wrangler.toml), same as the Go binary's one shared
// dispatcher behind five SQS-triggered Lambda functions. Queues' retry
// model (max_retries + dead_letter_queue in wrangler.toml) plays the
// same role as SQS's ReportBatchItemFailures: a thrown error here means
// "retry this message", same as returning an error did in Go.
import { emit, registry } from "../observability/events";
import type { Env } from "../config";
import { getDb } from "../db";
import { processDocument, type OCRResult } from "../pipelines/ocr";
import { reconcileBatch, type Invoice, type BankRow } from "../pipelines/reconciliation";
import { fetchGSTR2B, parseGSTR2BSuppliers, crossVerifyVendors, type InternalVendor } from "../pipelines/gstsync";
import { verifyGSTIN, verifyPAN, verifyBankAccount } from "../pipelines/identity";
import { getDocumentById, updateDocumentFields, findDuplicateDocument, listInvoicesWithTaxIdentifier } from "../repository/documents";
import { listUnmatchedInDateRange, markTransactionMatched } from "../repository/bankTransactions";
import { detectMissingInvoices } from "../pipelines/missingInvoice";
import { createAnomaly } from "../repository/anomalies";
import { appendAuditLog } from "../repository/auditLog";
import { getTaxIdentifierById, updateTaxIdentifierVerification } from "../repository/taxIdentifiers";
import { getBankAccountById, updateBankAccountVerification } from "../repository/bankAccounts";
import { decryptField } from "../security/fieldEncryption";
import { reconcileTenant } from "../pipelines/tenantReconcile";

interface TaskMessage {
  task: string;
  job_id: string;
  args: Record<string, any>;
}

// Thrown by a task when the failure is the OUTSIDE world being slow/down (timeout, 429, 5xx) rather than a bug or a
// real rejection. The message is retried with exponential backoff instead of being recorded as a permanent failure.
export class TransientTaskError extends Error {}

function argStr(args: Record<string, any>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

// Shared by both the queue-driven path below (WhatsApp/email ingestion
// — no browser involved, always called with ocrAvailable: false) and
// the web-upload path (routes/documents.ts), which calls this directly
// instead of round-tripping through OCR_QUEUE, since browser-side OCR
// already ran before the file was even uploaded.
export async function finalizeOcrResult(env: Env, sql: ReturnType<typeof getDb>, tenantId: string, documentId: string, result: OCRResult): Promise<void> {
  const updated = await updateDocumentFields(sql, tenantId, documentId, {
    processingStatus: result.ocrAvailable ? "PARSED" : "PENDING",
    vendorName: result.vendorName || undefined,
    documentDate: result.documentDate || undefined,
    rawTotalAmount: result.rawTotalAmount || undefined,
    taxAmount: result.taxAmount || undefined,
    taxIdentifier: result.taxIdentifier || undefined,
    invoiceNumber: result.invoiceNumber || undefined,
    ocrConfidenceScore: result.confidence,
    ocrErrorMessage: result.ocrAvailable ? undefined : "No OCR data available for this document — enter details manually",
  });
  console.log("ocr_pipeline_completed", { documentId, ocrAvailable: result.ocrAvailable });

  await checkForDuplicateInvoice(sql, tenantId, documentId, updated.vendorName, updated.invoiceNumber, result.rawTotalAmount, result.documentDate);

  // Chain directly into reconciliation within the same invocation,
  // same rationale as the Go original: cheaper than a second queue
  // round trip. runReconciliation already no-ops cleanly when
  // amount/date are missing (ocrAvailable: false case), so this is
  // safe to call unconditionally.
  await runReconciliation(env, sql, { document_id: documentId, tenant_id: tenantId });
}

// WhatsApp/email ingestion (routes/webhooks.ts) still enqueues this —
// there's no browser in that flow to run client-side OCR, so this
// always resolves to ocrAvailable: false. See pipelines/ocr.ts's
// header comment for why there's no server-side OCR fallback for
// these channels rather than silently dropping the task.
async function runOCRPipeline(env: Env, args: Record<string, any>): Promise<void> {
  const documentId = argStr(args, "document_id");
  const tenantId = argStr(args, "tenant_id");
  const result = processDocument([]);

  const sql = getDb(env);
  try {
    await finalizeOcrResult(env, sql, tenantId, documentId, result);
  } finally {
    await sql.end();
  }
}

async function checkForDuplicateInvoice(sql: ReturnType<typeof getDb>, tenantId: string, documentId: string, vendorName: string | null, invoiceNumber: string | null, amount: number, documentDate: string): Promise<void> {
  if (!vendorName) return;
  try {
    const dup = await findDuplicateDocument(sql, tenantId, vendorName, invoiceNumber, amount, documentDate, documentId);
    if (!dup) return;

    await updateDocumentFields(sql, tenantId, documentId, { duplicateOfDocumentId: dup.documentId });
    const description = `Looks like a duplicate of document ${dup.documentId} — same vendor (${vendorName}) and matching invoice number or amount+date`;
    await createAnomaly(sql, {
      tenantId, documentId, anomalyType: "DUPLICATE_INVOICE", severity: "HIGH", description,
      suggestedAction: "Confirm this isn't a re-upload or a genuine duplicate vendor bill before including it in ITC claims",
    });
    await appendAuditLog(sql, { tenantId, entityType: "DOCUMENT", entityId: documentId, action: "DUPLICATE_DETECTED", reason: description, actorEmail: "system@marginpulse" });
    console.log("duplicate_invoice_detected", { documentId, duplicateOf: dup.documentId });
  } catch (e) {
    console.error("duplicate_invoice_check_failed", { documentId, error: (e as Error).message });
  }
}

export async function runReconciliation(env: Env, sqlIn: ReturnType<typeof getDb> | null, args: Record<string, any>): Promise<void> {
  const documentId = argStr(args, "document_id");
  const tenantId = argStr(args, "tenant_id");
  const sql = sqlIn ?? getDb(env);
  const ownConnection = !sqlIn;
  try {
    const doc = await getDocumentById(sql, tenantId, documentId);
    if (!doc) throw new Error(`document ${documentId} not found`);
    if (!doc.rawTotalAmount || parseFloat(doc.rawTotalAmount) === 0 || !doc.documentDate) {
      console.log("reconciliation_skipped_no_amount_or_date", { documentId });
      return;
    }

    const docDate = new Date(`${doc.documentDate}T00:00:00Z`);
    const startDate = new Date(docDate.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const endDate = new Date(docDate.getTime() + 45 * 86_400_000).toISOString().slice(0, 10);
    const candidates = await listUnmatchedInDateRange(sql, tenantId, startDate, endDate);

    const invoice: Invoice = { documentId: doc.documentId, invoiceNumber: doc.invoiceNumber ?? undefined, vendorName: doc.vendorName ?? "", rawTotalAmount: parseFloat(doc.rawTotalAmount), documentDate: doc.documentDate };
    const bankRows: BankRow[] = candidates.map((c) => ({ transactionId: c.transactionId, narration: c.narration ?? "", debitAmount: parseFloat(c.debitAmount), transactionDate: c.transactionDate }));

    const [result] = reconcileBatch([invoice], bankRows);
    if (!result) return;

    const docStatus = result.status === "RECONCILED" ? "RECONCILED" : "PARSED";
    await updateDocumentFields(sql, tenantId, documentId, {
      reconciliationScore: result.score,
      processingStatus: docStatus,
      matchedBankTransactionId: result.matchedBankTransactionId ?? undefined,
      reconciliationReason: result.reason,
    });

    // RECONCILED needs no human attention. MANUAL_REVIEW and UNMATCHED
    // both get an anomaly so they surface on the dashboard with the
    // specific reason attached.
    if (result.status === "MANUAL_REVIEW" || result.status === "UNMATCHED") {
      await createAnomaly(sql, {
        tenantId, documentId, anomalyType: `RECONCILIATION_${result.status}`,
        severity: result.status === "UNMATCHED" ? "LOW" : "MEDIUM",
        description: result.reason,
        suggestedAction: "Review the candidate match and either confirm it manually or upload the missing bank statement",
      });
    }

    if (result.matchedBankTransactionId) {
      await markTransactionMatched(sql, tenantId, result.matchedBankTransactionId, documentId, result.score);
    }
    console.log("reconciliation_completed", { documentId, status: result.status, score: result.score });
  } finally {
    if (ownConnection) await sql.end();
  }
}

async function syncGSTPortal(env: Env, args: Record<string, any>): Promise<void> {
  const tenantId = argStr(args, "tenant_id");
  const gstin = argStr(args, "gstin");
  const period = argStr(args, "period");

  const gstr2bJSON = await fetchGSTR2B(env, gstin, period);
  const portalSuppliers = parseGSTR2BSuppliers(gstr2bJSON);

  const sql = getDb(env);
  try {
    const invoices = await listInvoicesWithTaxIdentifier(sql, tenantId);
    const internalVendors: InternalVendor[] = invoices.map((inv) => ({
      documentId: inv.documentId, vendorName: inv.vendorName ?? "", taxIdentifier: inv.taxIdentifier ?? "",
      rawTotalAmount: parseFloat(inv.rawTotalAmount ?? "0"), invoiceNumber: inv.invoiceNumber ?? "",
    }));
    const results = crossVerifyVendors(internalVendors, portalSuppliers);
    for (const r of results) {
      try {
        await updateDocumentFields(sql, tenantId, r.documentId, { gstPortalStatus: r.gstPortalStatus });
      } catch (e) {
        console.error("gst_sync_document_update_failed", { documentId: r.documentId, error: (e as Error).message });
      }
    }
    console.log("gst_sync_completed", { tenantId, vendorsChecked: internalVendors.length });
  } finally {
    await sql.end();
  }
}

async function verifyTaxIdentifierTask(env: Env, args: Record<string, any>): Promise<void> {
  const taxIdentifierId = argStr(args, "tax_identifier_id");
  const tenantId = argStr(args, "tenant_id");

  const sql = getDb(env);
  try {
    const taxId = await getTaxIdentifierById(sql, tenantId, taxIdentifierId);
    if (!taxId) throw new Error(`tax identifier ${taxIdentifierId} not found`);

    let result;
    if (taxId.idType === "GSTIN") result = await verifyGSTIN(env, taxId.idValue);
    else if (taxId.idType === "PAN") result = await verifyPAN(env, taxId.idValue, taxId.label ?? undefined);
    else result = { status: "PENDING" as const, error: "No automated verifier for this type yet — verify manually" };

    if ("transient" in result && result.transient) throw new TransientTaskError(result.error ?? "verification provider unavailable");
    await updateTaxIdentifierVerification(sql, tenantId, taxIdentifierId, result.status, result.legalName ?? null, result.error ?? null, null);
    console.log("tax_identifier_verification_completed", { taxIdentifierId, status: result.status });
  } finally {
    await sql.end();
  }
}

async function verifyBankAccountTask(env: Env, args: Record<string, any>): Promise<void> {
  const bankAccountId = argStr(args, "bank_account_id");
  const tenantId = argStr(args, "tenant_id");

  const sql = getDb(env);
  try {
    const account = await getBankAccountById(sql, tenantId, bankAccountId);
    if (!account) throw new Error(`bank account ${bankAccountId} not found`);

    const plaintext = await decryptField(env, account.accountNumberEncrypted);
    const result = await verifyBankAccount(env, plaintext, account.ifscCode, account.accountHolderName);
    // plaintext goes out of scope here and is never stored/logged.

    if (result.transient) throw new TransientTaskError(result.error ?? "verification provider unavailable");
    await updateBankAccountVerification(sql, tenantId, bankAccountId, result.status, result.verifiedName ?? null, result.error ?? null);
    console.log("bank_account_verification_completed", { bankAccountId, status: result.status });
  } finally {
    await sql.end();
  }
}

// One global reconcile pass for a tenant (enqueued by POST /reconciliation/run). Idempotent: re-running it on
// already-reconciled data changes nothing, so a retried or duplicated message is harmless.
async function reconcileTenantTask(env: Env, args: Record<string, any>): Promise<void> {
  const tenantId = argStr(args, "tenant_id");
  const sql = getDb(env);
  try {
    const tally = await reconcileTenant(sql, tenantId);
    console.log("tenant_reconciliation_completed", { tenantId, ...tally });
  } finally {
    await sql.end();
  }
}

// Daily missing-invoice detection for ONE tenant (fanned out by the cron trigger, so 5 lakh tenants are not swept in a single
// invocation). Idempotent: an anomaly already open for a transaction is never duplicated.
async function detectMissingInvoicesTask(env: Env, args: Record<string, any>): Promise<void> {
  const tenantId = argStr(args, "tenant_id");
  const sql = getDb(env);
  try {
    const r = await detectMissingInvoices(sql, tenantId);
    if (r.anomaliesCreated > 0) console.log("scheduled_missing_invoice_sweep", { tenantId, ...r });
  } finally {
    await sql.end();
  }
}

export const TASK_REGISTRY: Record<string, (env: Env, args: Record<string, any>) => Promise<void>> = {
  detect_missing_invoices: detectMissingInvoicesTask,
  run_ocr_pipeline: runOCRPipeline,
  run_reconciliation: (env, args) => runReconciliation(env, null, args),
  reconcile_tenant: reconcileTenantTask,
  sync_gst_portal: syncGSTPortal,
  verify_tax_identifier: verifyTaxIdentifierTask,
  verify_bank_account_task: verifyBankAccountTask,
};

// Cloudflare Queues consumer entry point — wired up from src/index.ts's exported `queue()` handler.
// Each message is acked/retried individually. Messages in a batch run CONCURRENTLY (allSettled): one slow
// message — e.g. a hung bank/GST provider call — can no longer hold every other message in the batch hostage.
// Failures retry with exponential backoff (10 s, 20 s, 40 s … capped at 15 min) so a struggling provider isn't hammered.
const MAX_TRANSIENT_ATTEMPTS = 6;
const backoff = (attempts: number) => Math.min(900, 10 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));

// Metrics for every outcome: without these, retries, failures and give-ups existed only as log lines and Grafana was blind to them.
async function handleOne(message: Message<TaskMessage>): Promise<void> {
  const task = TASK_REGISTRY[message.body?.task] ? message.body.task : "unknown";
  const t0 = Date.now();
  const done = (outcome: "ok" | "retry" | "gave_up" | "unknown", extra: Record<string, string> = {}) => {
    emit("queue_task", { task, outcome, ...extra });
    if (outcome !== "unknown") registry.observe("marginpulse.queue.task.duration", "s", (Date.now() - t0) / 1000, { task, outcome });
  };
  await runOne(message, done);
}

async function runOne(message: Message<TaskMessage>, done: (o: "ok" | "retry" | "gave_up" | "unknown", extra?: Record<string, string>) => void): Promise<void> {
  const msg = message.body;
  const taskFn = TASK_REGISTRY[msg.task];
  if (!taskFn) {
    console.error("unknown_task", { task: msg.task, jobId: msg.job_id });
    done("unknown");
    message.ack(); // unknown task type — don't retry forever, drop it
    return;
  }
  const attempts = message.attempts ?? 1;
  console.log("task_started", { task: msg.task, jobId: msg.job_id, attempts });
  try {
    await taskFn(currentEnv!, msg.args);
    console.log("task_completed", { task: msg.task, jobId: msg.job_id });
    done("ok");
    message.ack();
  } catch (e) {
    const transient = e instanceof TransientTaskError;
    if (transient && attempts >= MAX_TRANSIENT_ATTEMPTS) {
      // The provider stayed down for the whole retry budget. The record stays PENDING (never marked FAILED) so the
      // user can re-verify later; acking stops the infinite loop.
      console.error("task_gave_up", { task: msg.task, jobId: msg.job_id, attempts, error: (e as Error).message });
      done("gave_up");
      message.ack();
      return;
    }
    console.error("task_failed", { task: msg.task, jobId: msg.job_id, attempts, transient, error: (e as Error).message });
    done("retry", { transient: String(transient) });
    message.retry({ delaySeconds: backoff(attempts) });
  }
}

let currentEnv: Env | null = null;
export async function handleQueueBatch(batch: MessageBatch<TaskMessage>, env: Env): Promise<void> {
  currentEnv = env;
  await Promise.allSettled(batch.messages.map((m) => handleOne(m)));
}
