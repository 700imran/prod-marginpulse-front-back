import { emit } from "../observability/events";
import type { Sql } from "../db";
import { reconcileBatch, type Invoice, type BankRow } from "./reconciliation";
import { listByStatus, updateDocumentFields } from "../repository/documents";
import { listUnmatchedBankTransactions, markTransactionMatched } from "../repository/bankTransactions";
import { createAnomaly } from "../repository/anomalies";

// Reconciles every PARSED document against every UNMATCHED bank debit in ONE
// global one-to-one pass (so a bank row can never be claimed twice). Used
// after bulk dataset uploads.
export async function reconcileTenant(sql: Sql, tenantId: string): Promise<{ reconciled: number; review: number; unmatched: number; failed: number }> {
  const docs = (await listByStatus(sql, tenantId, "PARSED")).filter((d) => !d.duplicateOfDocumentId);
  const bank = await listUnmatchedBankTransactions(sql, tenantId);
  const invoices: Invoice[] = docs.map((d) => ({
    documentId: d.documentId, vendorName: d.vendorName ?? "", invoiceNumber: d.invoiceNumber ?? undefined,
    rawTotalAmount: parseFloat(d.rawTotalAmount ?? "0") || 0, documentDate: d.documentDate ?? "",
  }));
  const rows: BankRow[] = bank.map((b) => ({ transactionId: b.transactionId, narration: b.narration ?? "", debitAmount: parseFloat(b.debitAmount) || 0, transactionDate: b.transactionDate }));
  const results = reconcileBatch(invoices, rows);
  const prevReason = new Map(docs.map((d) => [d.documentId, d.reconciliationReason]));

  const tally = { reconciled: 0, review: 0, unmatched: 0, failed: 0 };
  for (const r of results) {
    await updateDocumentFields(sql, tenantId, r.documentId, {
      reconciliationScore: r.score, reconciliationReason: r.reason,
      processingStatus: r.status === "RECONCILED" ? "RECONCILED" : "PARSED",
      matchedBankTransactionId: r.matchedBankTransactionId ?? undefined,
    });
    if (r.matchedBankTransactionId) await markTransactionMatched(sql, tenantId, r.matchedBankTransactionId, r.documentId, r.score);
    if (r.status === "RECONCILED") tally.reconciled++;
    else if (r.status === "FAILED") tally.failed++;
    else if (r.status === "MANUAL_REVIEW") tally.review++;
    else tally.unmatched++;
    // Anomalies only when something changed since the last run (no duplicates on re-runs),
    // and "unmatched" only if a bank statement exists to have matched against.
    const changed = prevReason.get(r.documentId) !== r.reason;
    if (changed && (r.status === "MANUAL_REVIEW" || (r.status === "UNMATCHED" && rows.length > 0))) {
      await createAnomaly(sql, {
        tenantId, documentId: r.documentId, anomalyType: `RECONCILIATION_${r.status}`,
        severity: r.status === "UNMATCHED" ? "LOW" : "MEDIUM", description: r.reason,
        suggestedAction: "Review the candidate match and either confirm it manually or upload the missing bank statement",
      });
    }
  }
  emit("reconciliation_run", { outcome: "reconciled" }, tally.reconciled);
  emit("reconciliation_run", { outcome: "review" }, tally.review);
  emit("reconciliation_run", { outcome: "unmatched" }, tally.unmatched);
  return tally;
}
