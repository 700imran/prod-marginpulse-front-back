import type { Sql } from "../db";
import { exportPage } from "../repository/documents";
import { csvRow } from "../lib/csv";

export const EXPORT_HEADER = [
  "document_id", "vendor_name", "invoice_number", "document_date", "raw_total_amount",
  "tax_amount", "tax_identifier", "processing_status", "ocr_confidence_score",
  "reconciliation_score", "matched_bank_transaction_id", "gst_portal_status",
  "exception_reason", "duplicate_of_document_id", "manually_corrected", "created_at", "doc_type",
];

export const MAX_EXPORT_ROWS = 250_000; // hard ceiling so one tenant can't exhaust a Worker's memory
const PAGE = 2000;
const isoOf = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

// Builds the audit/reconciliation report page by page (keyset pagination: O(page) per query no matter how deep,
// unlike OFFSET) and returns the CSV text plus whether it was truncated at the ceiling.
export async function buildReportCsv(sql: Sql, tenantId: string): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const lines = [EXPORT_HEADER.join(",")];
  let cursor: { ts: string; id: string } | null = null;
  let rows = 0;
  for (;;) {
    const page = await exportPage(sql, tenantId, cursor, PAGE);
    for (const d of page.rows) {
      lines.push(csvRow([
        d.documentId, d.vendorName, d.invoiceNumber, d.documentDate, d.rawTotalAmount, d.taxAmount, d.taxIdentifier, d.processingStatus,
        d.ocrConfidenceScore, d.reconciliationScore, d.matchedBankTransactionId, d.gstPortalStatus, d.reconciliationReason,
        d.duplicateOfDocumentId, d.manuallyCorrected, isoOf(d.createdAt), d.docType,
      ]));
      rows++;
    }
    cursor = page.next;
    if (!cursor) break;
    if (rows >= MAX_EXPORT_ROWS) return { csv: lines.join("\n"), rows, truncated: true };
  }
  return { csv: lines.join("\n"), rows, truncated: false };
}
