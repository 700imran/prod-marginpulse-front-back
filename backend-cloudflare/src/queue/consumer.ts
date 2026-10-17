// Exact port of cmd/worker/main.go. One consumer Worker drains all 5
// Cloudflare Queues (wrangler.toml), same as the Go binary's one shared
// dispatcher behind five SQS-triggered Lambda functions. Queues' retry
// model (max_retries + dead_letter_queue in wrangler.toml) plays the
// same role as SQS's ReportBatchItemFailures: a thrown error here means
// "retry this message", same as returning an error did in Go.
import type { Env } from "../config";
import { getDb } from "../db";
import { processDocument, type OCRResult } from "../pipelines/ocr";
import { reconcileBatch, type Invoice, type BankRow } from "../pipelines/reconciliation";
import { fetchGSTR2B, parseGSTR2BSuppliers, crossVerifyVendors, type InternalVendor } from "../pipelines/gstsync";
import { verifyGSTIN, verifyPAN, verifyBankAccount } from "../pipelines/identity";
import { getDocumentById, updateDocumentFields, findDuplicateDocument, listInvoicesWithTaxIdentifier } from "../repository/documents";
import { listUnmatchedInDateRange, markTransactionMatched } from "../repository/bankTransactions";
import { createAnomaly } from "../repository/anomalies";
import { appendAuditLog } from "../repository/auditLog";
import { getTaxIdentifierById, updateTaxIdentifierVerification } from "../repository/taxIdentifiers";
import { getBankAccountById, updateBankAccountVerification } from "../repository/bankAccounts";
import { decryptField } from "../security/fieldEncryption";
import { setTenantContext } from "../security/tenantContext";
import { reportError } from "../monitoring";
import { refundCredits } from "../billing/credits";
import { recordUsageEvent } from "../billing/usage";

interface CreditReservation {
  tenant_id: string;
  operation: string;
  amount: number;
}

interface TaskMessage {
  task: string;
  job_id: string;
  args: Record<string, any>;
  // Present only for tasks whose enqueueing route reserved usage credits
  // up front (routes/gst.ts, routes/taxIdentifiers.ts,
  // routes/bankAccounts.ts). Used below to log the successful spend, and
  // by handleDeadLetterBatch to refund it if the job never completes.
  credit_reservation?: CreditReservation;
}

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
    // Every table finalizeOcrResult (and what it chains into) touches is
    // Row-Level-Security scoped by tenant_id — see db/schema.sql. This is
    // the one point on the queue-driven ingestion path where the tenant
    // is first known, so it's set here before anything else runs.
    await setTenantContext(sql, tenantId);
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

async function runReconciliation(env: Env, sqlIn: ReturnType<typeof getDb> | null, args: Record<string, any>): Promise<void> {
  const documentId = argStr(args, "document_id");
  const tenantId = argStr(args, "tenant_id");
  const sql = sqlIn ?? getDb(env);
  const ownConnection = !sqlIn;
  try {
    // When called standalone (the run_reconciliation queue task, or a
    // future direct caller), this is the first query on the connection,
    // so tenant context needs setting here. When chained from
    // finalizeOcrResult (sqlIn passed in), the caller already set it on
    // this same connection — setting it again would be harmless but
    // redundant, so it's skipped.
    if (ownConnection) await setTenantContext(sql, tenantId);
    const doc = await getDocumentById(sql, tenantId, documentId);
    if (!doc) throw new Error(`document ${documentId} not found`);
    if (!doc.rawTotalAmount || parseFloat(doc.rawTotalAmount) === 0 || !doc.documentDate) {
      console.log("reconciliation_skipped_no_amount_or_date", { documentId });
      return;
    }

    const docDate = new Date(`${doc.documentDate}T00:00:00Z`);
    const startDate = new Date(docDate.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
    const endDate = new Date(docDate.getTime() + 10 * 86_400_000).toISOString().slice(0, 10);
    const candidates = await listUnmatchedInDateRange(sql, tenantId, startDate, endDate);

    const invoice: Invoice = { documentId: doc.documentId, vendorName: doc.vendorName ?? "", rawTotalAmount: parseFloat(doc.rawTotalAmount), documentDate: doc.documentDate };
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
      await markTransactionMatched(sql, result.matchedBankTransactionId, documentId, result.score);
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
    await setTenantContext(sql, tenantId);
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
    await setTenantContext(sql, tenantId);
    const taxId = await getTaxIdentifierById(sql, tenantId, taxIdentifierId);
    if (!taxId) throw new Error(`tax identifier ${taxIdentifierId} not found`);

    let result;
    if (taxId.idType === "GSTIN") result = await verifyGSTIN(env, taxId.idValue);
    else if (taxId.idType === "PAN") result = await verifyPAN(env, taxId.idValue, taxId.label ?? undefined);
    else result = { status: "PENDING" as const, error: "No automated verifier for this type yet — verify manually" };

    await updateTaxIdentifierVerification(sql, taxIdentifierId, result.status, result.legalName ?? null, result.error ?? null, null);
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
    await setTenantContext(sql, tenantId);
    const account = await getBankAccountById(sql, tenantId, bankAccountId);
    if (!account) throw new Error(`bank account ${bankAccountId} not found`);

    const plaintext = await decryptField(env, account.accountNumberEncrypted);
    const result = await verifyBankAccount(env, plaintext, account.ifscCode, account.accountHolderName);
    // plaintext goes out of scope here and is never stored/logged.

    await updateBankAccountVerification(sql, bankAccountId, result.status, result.verifiedName ?? null, result.error ?? null);
    console.log("bank_account_verification_completed", { bankAccountId, status: result.status });
  } finally {
    await sql.end();
  }
}

const TASK_REGISTRY: Record<string, (env: Env, args: Record<string, any>) => Promise<void>> = {
  run_ocr_pipeline: runOCRPipeline,
  run_reconciliation: (env, args) => runReconciliation(env, null, args),
  sync_gst_portal: syncGSTPortal,
  verify_tax_identifier: verifyTaxIdentifierTask,
  verify_bank_account_task: verifyBankAccountTask,
};

// Cloudflare Queues consumer entry point — wired up from src/index.ts's
// exported `queue()` handler. Each message is acked/retried
// individually (message.ack() / message.retry()), same effect as SQS's
// per-item BatchItemFailures. Also handles the *-dlq queues (see
// wrangler.toml) via the same entry point, disambiguated by batch.queue —
// Cloudflare routes every bound consumer queue to this one Worker export.
export async function handleQueueBatch(batch: MessageBatch<TaskMessage>, env: Env): Promise<void> {
  if (batch.queue?.endsWith("-dlq")) {
    await handleDeadLetterBatch(batch, env);
    return;
  }

  // Opened once per batch, used only for usage-event bookkeeping below —
  // each task function still opens/closes its own connection as before,
  // this doesn't change their transaction boundaries.
  const sql = getDb(env);
  try {
    for (const message of batch.messages) {
      const msg = message.body;
      const taskFn = TASK_REGISTRY[msg.task];
      if (!taskFn) {
        await reportError(env, new Error(`unknown task type: ${msg.task}`), { tags: { area: "queue", jobId: msg.job_id, queue: batch.queue } });
        message.ack(); // unknown task type — don't retry forever, drop it
        continue;
      }
      console.log("task_started", { task: msg.task, jobId: msg.job_id });
      try {
        await taskFn(env, msg.args);
        console.log("task_completed", { task: msg.task, jobId: msg.job_id });
        const reservation = msg.credit_reservation;
        if (reservation) {
          // The debit already happened at reserve time (routes/*.ts) —
          // this just records that the paid-for work actually succeeded,
          // for the /billing/usage view and any future cost dashboards.
          // usage_events is RLS-scoped like every other tenant table, and
          // this `sql` connection is shared across the whole batch (which
          // can span several tenants), so the context has to be set fresh
          // for each message rather than once for the batch.
          try {
            await setTenantContext(sql, reservation.tenant_id);
            await recordUsageEvent(sql, {
              tenantId: reservation.tenant_id, provider: reservation.operation,
              operation: reservation.operation, outcome: "SUCCESS",
              creditsConsumed: reservation.amount, correlationId: msg.job_id, jobId: msg.job_id,
            });
          } catch (e) {
            console.error("usage_event_log_failed", { jobId: msg.job_id, error: (e as Error).message });
          }
        }
        message.ack();
      } catch (e) {
        // A single retryable failure isn't necessarily a problem (queues
        // retry by design) — "warning", not "error". The DLQ path below
        // is what reports at full severity, since that's the point a
        // failure has actually become permanent.
        await reportError(env, e, { severity: "warning", tags: { area: "queue", task: msg.task, jobId: msg.job_id, queue: batch.queue } });
        message.retry();
      }
    }
  } finally {
    await sql.end();
  }
}

// Runs for messages that exhausted max_retries on their original queue and
// landed in its dead_letter_queue (wrangler.toml). This is the only place
// a permanently-failed, credit-reserved job gets refunded — the normal
// per-message catch block above only sees retryable failures, never the
// final one, since Cloudflare moves the message to the DLQ without
// invoking this Worker again on that queue.
async function handleDeadLetterBatch(batch: MessageBatch<TaskMessage>, env: Env): Promise<void> {
  const sql = getDb(env);
  try {
    for (const message of batch.messages) {
      const msg = message.body;
      await reportError(env, new Error(`task ${msg.task} exhausted retries`), { tags: { area: "queue_dlq", task: msg.task, jobId: msg.job_id, queue: batch.queue } });
      try {
        const reservation = msg.credit_reservation;
        if (reservation) {
          await setTenantContext(sql, reservation.tenant_id);
          const refund = await refundCredits(sql, {
            tenantId: reservation.tenant_id,
            amount: reservation.amount,
            operation: reservation.operation,
            jobId: msg.job_id,
            description: `Refund: ${reservation.operation} failed permanently after retries (${batch.queue})`,
          });
          await recordUsageEvent(sql, {
            tenantId: reservation.tenant_id, provider: reservation.operation,
            operation: reservation.operation, outcome: "REFUNDED",
            creditsConsumed: -reservation.amount, correlationId: msg.job_id, jobId: msg.job_id,
          });
          console.log("credits_refunded_after_dlq", { jobId: msg.job_id, amount: reservation.amount, balanceAfter: refund.balanceAfter });
        }
      } catch (e) {
        // Never let a refund failure cause an infinite DLQ-of-the-DLQ
        // retry loop — this needs a human, so log loudly and still ack
        // so the queue drains. Today that log only goes wherever you
        // point Workers Logs / `wrangler tail` — see STATUS.md's
        // monitoring section for wiring this to a real alert channel.
        console.error("dlq_refund_failed", { jobId: msg.job_id, error: (e as Error).message });
      }
      message.ack();
    }
  } finally {
    await sql.end();
  }
}
