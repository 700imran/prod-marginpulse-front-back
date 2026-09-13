// Exact port of internal/pipelines/exceptions/missing_invoice.go.
import type { Sql } from "../db";
import { levenshteinRatio } from "./reconciliation";
import { listVendorNames } from "../repository/documents";
import { listUnmatchedInDateRange } from "../repository/bankTransactions";
import { existsOpenForRelatedTransaction, createAnomaly } from "../repository/anomalies";
import { appendAuditLog } from "../repository/auditLog";

// Deliberately looser than the reconciliation engine's own thresholds —
// this flags for human review, not an auto-match, so a lower bar
// (catching more true positives at the cost of a few false ones a human
// can dismiss in one click) is the right tradeoff here.
const VENDOR_NARRATION_MATCH_THRESHOLD = 0.55;
// How long a bank debit must have sat UNMATCHED before it's treated as a
// possible missing invoice rather than "still waiting on OCR/reconciliation".
const OLDER_THAN_DAYS = 5;

export interface DetectionResult {
  bankTransactionsScanned: number;
  anomaliesCreated: number;
}

export async function detectMissingInvoices(sql: Sql, tenantId: string): Promise<DetectionResult> {
  const vendorNames = await listVendorNames(sql, tenantId);
  if (vendorNames.length === 0) return { bankTransactionsScanned: 0, anomaliesCreated: 0 };

  const cutoff = new Date(Date.now() - OLDER_THAN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const txns = await listUnmatchedInDateRange(sql, tenantId, "0000-01-01", cutoff);

  let anomaliesCreated = 0;
  for (const txn of txns) {
    const debit = parseFloat(txn.debitAmount);
    if (!debit) continue; // only debits (money going out) look like vendor payments

    let bestVendor = "";
    let bestScore = 0;
    for (const vendor of vendorNames) {
      const score = levenshteinRatio(vendor, txn.narration ?? "");
      if (score > bestScore) {
        bestScore = score;
        bestVendor = vendor;
      }
    }
    if (bestScore < VENDOR_NARRATION_MATCH_THRESHOLD) continue;

    if (await existsOpenForRelatedTransaction(sql, tenantId, txn.transactionId)) continue;

    const description = `Bank debit of ${debit.toFixed(2)} on ${txn.transactionDate} ("${txn.narration}") looks like a payment to ${bestVendor}, but no matching invoice has been uploaded`;
    await createAnomaly(sql, {
      tenantId,
      relatedTransactionId: txn.transactionId,
      anomalyType: "MISSING_INVOICE",
      severity: "MEDIUM",
      description,
      suggestedAction: `Upload the invoice from ${bestVendor} for this payment, or mark it as not requiring one`,
    });
    await appendAuditLog(sql, {
      tenantId,
      entityType: "BANKTXN",
      entityId: txn.transactionId,
      action: "MISSING_INVOICE_DETECTED",
      reason: description,
      actorEmail: "system@marginpulse",
    });
    anomaliesCreated++;
  }
  return { bankTransactionsScanned: txns.length, anomaliesCreated };
}
