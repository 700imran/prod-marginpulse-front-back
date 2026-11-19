import { emit } from "../observability/events";
import type { Sql } from "../db";
import { reconcileBatchBudgeted, type Invoice, type BankRow } from "./reconciliation";
import { listByStatus } from "../repository/documents";
import { listUnmatchedBankTransactions } from "../repository/bankTransactions";

const CHUNK = 1000;
const chunks = <T>(a: T[], n = CHUNK): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Reconciles every PARSED invoice against every UNMATCHED bank debit in ONE global one-to-one pass (so a bank row
// can never be claimed twice). Used after bulk dataset uploads and by the queued "re-run reconciliation" job.
//
// All writes are set-based (a handful of statements per 1,000 rows via jsonb_to_recordset) instead of 3 round trips per
// document: with a real network RTT between the Worker and Postgres the per-row version took minutes for a few
// thousand rows and was the reason "re-run reconciliation" appeared to hang.
export async function reconcileTenant(sql: Sql, tenantId: string, env?: { RECONCILE_MAX_PAIRS?: string; RECONCILE_MAX_TOTAL_PAIRS?: string }): Promise<{ reconciled: number; review: number; unmatched: number; failed: number }> {
  const docs = (await listByStatus(sql, tenantId, "PARSED")).filter((d) => !d.duplicateOfDocumentId && d.docType === "INVOICE");
  const bank = await listUnmatchedBankTransactions(sql, tenantId);
  const invoices: Invoice[] = docs.map((d) => ({
    documentId: d.documentId, vendorName: d.vendorName ?? "", invoiceNumber: d.invoiceNumber ?? undefined,
    rawTotalAmount: parseFloat(d.rawTotalAmount ?? "0") || 0, documentDate: d.documentDate ?? "",
  }));
  const rows: BankRow[] = bank.map((b) => ({ transactionId: b.transactionId, narration: b.narration ?? "", debitAmount: parseFloat(b.debitAmount) || 0, transactionDate: b.transactionDate }));
  // Bounded working set: identical to a single global pass unless the data is dense enough to exhaust a Worker's memory (see reconciliation.ts).
  const results = reconcileBatchBudgeted(invoices, rows, {
    maxPairs: Number(env?.RECONCILE_MAX_PAIRS) || undefined,
    maxTotalPairs: Number(env?.RECONCILE_MAX_TOTAL_PAIRS) || undefined,
    onCapped: (skipped) => { emit("reconciliation_capped", {}, skipped); console.error(JSON.stringify({ level: "error", msg: "reconcile_capped", tenantId, skipped })); },
    onSliced: (slices) => { emit("reconciliation_sliced", {}, slices); console.warn(JSON.stringify({ level: "warn", msg: "reconcile_sliced", tenantId, invoices: invoices.length, bankRows: rows.length, slices })); },
  });
  const prevReason = new Map(docs.map((d) => [d.documentId, d.reconciliationReason]));

  const tally = { reconciled: 0, review: 0, unmatched: 0, failed: 0 };
  const docUpdates: { id: string; score: number; reason: string; status: string; bank: string | null }[] = [];
  const bankUpdates: { bank: string; doc: string; score: number }[] = [];
  const anomalies: Record<string, unknown>[] = [];
  const resolvedDocs: string[] = [];

  for (const r of results) {
    docUpdates.push({ id: r.documentId, score: r.score, reason: r.reason, status: r.status === "RECONCILED" ? "RECONCILED" : "PARSED", bank: r.matchedBankTransactionId });
    if (r.matchedBankTransactionId) bankUpdates.push({ bank: r.matchedBankTransactionId, doc: r.documentId, score: r.score });
    if (r.status === "RECONCILED") { tally.reconciled++; resolvedDocs.push(r.documentId); }
    else if (r.status === "FAILED") tally.failed++;
    else if (r.status === "MANUAL_REVIEW") tally.review++;
    else tally.unmatched++;
    // Anomalies only when something changed since the last run (no duplicates on re-runs),
    // and "unmatched" only if a bank statement exists to have matched against.
    const changed = prevReason.get(r.documentId) !== r.reason;
    if (changed && (r.status === "MANUAL_REVIEW" || (r.status === "UNMATCHED" && rows.length > 0))) {
      anomalies.push({
        tenant_id: tenantId, document_id: r.documentId, anomaly_type: `RECONCILIATION_${r.status}`,
        severity: r.status === "UNMATCHED" ? "LOW" : "MEDIUM", description: r.reason,
        suggested_action: "Review the candidate match and either confirm it manually or upload the missing bank statement",
      });
    }
  }

  for (const part of chunks(docUpdates)) {
    await sql`
      update documents d set reconciliation_score = v.score, reconciliation_reason = v.reason, processing_status = v.status,
        matched_bank_transaction_id = coalesce(v.bank, d.matched_bank_transaction_id), updated_at = now()
      from jsonb_to_recordset(${sql.json(part as any)}) as v(id uuid, score numeric, reason text, status text, bank uuid)
      where d.tenant_id = ${tenantId} and d.document_id = v.id`;
  }
  for (const part of chunks(bankUpdates)) {
    await sql`
      update bank_transactions b set reconciliation_status = 'MATCHED', matched_document_id = v.doc, match_score = v.score
      from jsonb_to_recordset(${sql.json(part as any)}) as v(bank uuid, doc uuid, score numeric)
      where b.tenant_id = ${tenantId} and b.transaction_id = v.bank`;
  }
  // A document that is now reconciled no longer needs the review/unmatched alerts raised on earlier runs.
  for (const part of chunks(resolvedDocs)) {
    await sql`
      update anomalies set status = 'RESOLVED', resolved_at = now(), resolved_by = 'system@marginpulse'
      where tenant_id = ${tenantId} and status = 'OPEN' and anomaly_type in ('RECONCILIATION_MANUAL_REVIEW','RECONCILIATION_UNMATCHED')
        and document_id in (select (x#>>'{}')::uuid from jsonb_array_elements(${sql.json(part as any)}) x)`;
  }
  for (const part of chunks(anomalies, 1500)) {
    await sql`insert into anomalies ${sql(part as any, "tenant_id", "document_id", "anomaly_type", "severity", "description", "suggested_action")}`;
  }

  emit("reconciliation_run", { outcome: "reconciled" }, tally.reconciled);
  emit("reconciliation_run", { outcome: "review" }, tally.review);
  emit("reconciliation_run", { outcome: "unmatched" }, tally.unmatched);
  return tally;
}
