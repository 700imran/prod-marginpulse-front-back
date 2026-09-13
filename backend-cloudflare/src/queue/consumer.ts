// Exact port of cmd/worker/main.go. One consumer Worker drains all 5
// Cloudflare Queues (wrangler.toml), same as the Go binary's one shared
// dispatcher behind five SQS-triggered Lambda functions. Queues' retry
// model (max_retries + dead_letter_queue in wrangler.toml) plays the
// same role as SQS's ReportBatchItemFailures: a thrown error here means
// "retry this message", same as returning an error did in Go.
import type { Env } from "../config";
import { getDb } from "../db";
import { downloadBytes } from "../storage";
import { processDocument } from "../pipelines/ocr";
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

interface TaskMessage {
  task: string;
  job_id: string;
  args: Record<string, any>;
}

function argStr(args: Record<string, any>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

async function runOCRPipeline(env: Env, args: Record<string, any>): Promise<void> {
  const documentId = argStr(args, "document_id");
  const storageKey = argStr(args, "storage_key");
  const mimeType = argStr(args, "mime_type");
  const tenantId = argStr(args, "tenant_id");

  const data = await downloadBytes(env, storageKey);
  if (!data) throw new Error(`document bytes missing from R2 for key ${storageKey}`);
  const result = await processDocument(env, data, mimeType);

  const sql = getDb(env);
  try {
    const updated = await updateDocumentFields(sql, tenantId, documentId, {
      processingStatus: "PARSED",
      vendorName: result.vendorName || undefined,
      documentDate: result.documentDate || undefined,
      rawTotalAmount: result.rawTotalAmount || undefined,
      taxAmount: result.taxAmount || undefined,
      taxIdentifier: result.taxIdentifier || undefined,
      invoiceNumber: result.invoiceNumber || undefined,
      ocrConfidenceScore: result.confidence,
    });
    console.log("ocr_pipeline_completed", { documentId });

    await checkForDuplicateInvoice(sql, tenantId, documentId, updated.vendorName, updated.invoiceNumber, result.rawTotalAmount, result.documentDate);

    // Chain directly into reconciliation within the same invocation,
    // same rationale as the Go original: cheaper than a second queue
    // round trip, and OCR re-running on a retry is idempotent since it
    // re-reads from R2.
    await runReconciliation(env, sql, { document_id: documentId, tenant_id: tenantId });
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
// per-item BatchItemFailures.
export async function handleQueueBatch(batch: MessageBatch<TaskMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;
    const taskFn = TASK_REGISTRY[msg.task];
    if (!taskFn) {
      console.error("unknown_task", { task: msg.task, jobId: msg.job_id });
      message.ack(); // unknown task type — don't retry forever, drop it
      continue;
    }
    console.log("task_started", { task: msg.task, jobId: msg.job_id });
    try {
      await taskFn(env, msg.args);
      console.log("task_completed", { task: msg.task, jobId: msg.job_id });
      message.ack();
    } catch (e) {
      console.error("task_failed", { task: msg.task, jobId: msg.job_id, error: (e as Error).message });
      message.retry();
    }
  }
}
