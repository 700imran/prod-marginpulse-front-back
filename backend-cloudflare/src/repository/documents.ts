import type { Sql } from "../db";

export interface DocumentRow {
  documentId: string;
  tenantId: string;
  docType: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  fileSizeBytes: number;
  vendorName: string | null;
  vendorAddress: string | null;
  documentDate: string | null;
  invoiceNumber: string | null;
  rawTotalAmount: string | null;
  subtotalAmount: string | null;
  taxAmount: string | null;
  currency: string;
  taxIdentifier: string | null;
  taxType: string | null;
  ingestChannel: string;
  processingStatus: string;
  ocrConfidenceScore: string | null;
  reconciliationScore: string | null;
  reconciliationReason: string | null;
  matchedBankTransactionId: string | null;
  gstPortalStatus: string;
  duplicateOfDocumentId: string | null;
  manuallyCorrected: boolean;
  createdAt: string;
  updatedAt: string;
}

const SELECT = `
  document_id as "documentId", tenant_id as "tenantId", doc_type as "docType",
  original_filename as "originalFilename", storage_key as "storageKey", mime_type as "mimeType",
  file_size_bytes as "fileSizeBytes", vendor_name as "vendorName", vendor_address as "vendorAddress",
  document_date as "documentDate", invoice_number as "invoiceNumber",
  raw_total_amount as "rawTotalAmount", subtotal_amount as "subtotalAmount", tax_amount as "taxAmount",
  currency, tax_identifier as "taxIdentifier", tax_type as "taxType", ingest_channel as "ingestChannel",
  processing_status as "processingStatus", ocr_confidence_score as "ocrConfidenceScore",
  reconciliation_score as "reconciliationScore", reconciliation_reason as "reconciliationReason",
  matched_bank_transaction_id as "matchedBankTransactionId", gst_portal_status as "gstPortalStatus",
  duplicate_of_document_id as "duplicateOfDocumentId", manually_corrected as "manuallyCorrected",
  created_at as "createdAt", updated_at as "updatedAt"
`;

export async function createDocument(
  sql: Sql,
  input: { tenantId: string; docType: string; originalFilename: string; storageKey: string; mimeType: string; fileSizeBytes: number; ingestChannel: string },
): Promise<DocumentRow> {
  const rows = await sql.unsafe<DocumentRow[]>(
    `insert into documents (tenant_id, doc_type, original_filename, storage_key, mime_type, file_size_bytes, ingest_channel)
     values ($1,$2,$3,$4,$5,$6,$7) returning ${SELECT}`,
    [input.tenantId, input.docType, input.originalFilename, input.storageKey, input.mimeType, input.fileSizeBytes, input.ingestChannel],
  );
  return rows[0]!;
}

export async function getDocumentById(sql: Sql, tenantId: string, documentId: string): Promise<DocumentRow | null> {
  const rows = await sql.unsafe<DocumentRow[]>(
    `select ${SELECT} from documents where tenant_id = $1 and document_id = $2`,
    [tenantId, documentId],
  );
  return rows[0] ?? null;
}

export interface ListDocumentsFilter {
  status?: string;
  docType?: string;
  gstPortalStatus?: string;
  fromDate?: string;
  toDate?: string;
  limit: number;
  offset: number;
}

export async function listDocumentsByTenant(sql: Sql, tenantId: string, f: ListDocumentsFilter): Promise<DocumentRow[]> {
  const clauses: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  const push = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(`${clause} $${params.length}`);
  };
  if (f.status) push("processing_status =", f.status);
  if (f.docType) push("doc_type =", f.docType);
  if (f.gstPortalStatus) push("gst_portal_status =", f.gstPortalStatus);
  if (f.fromDate) push("document_date >=", f.fromDate);
  if (f.toDate) push("document_date <=", f.toDate);
  params.push(f.limit, f.offset);
  const sqlText = `select ${SELECT} from documents where ${clauses.join(" and ")} order by created_at desc limit $${params.length - 1} offset $${params.length}`;
  return sql.unsafe<DocumentRow[]>(sqlText, params as any[]);
}

export async function countDocumentsByTenant(sql: Sql, tenantId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`select count(*)::text from documents where tenant_id = ${tenantId}`;
  return parseInt(rows[0]!.count, 10);
}

// Replaces ocr.go writing results back, plus reconciliation.go's match write-back.
export interface DocumentUpdatePatch {
  vendorName?: string | null;
  vendorAddress?: string | null;
  documentDate?: string | null;
  invoiceNumber?: string | null;
  rawTotalAmount?: number | null;
  taxAmount?: number | null;
  taxIdentifier?: string | null;
  ocrConfidenceScore?: number | null;
  processingStatus?: string;
  ocrErrorMessage?: string | null;
  reconciliationScore?: number | null;
  reconciliationReason?: string | null;
  matchedBankTransactionId?: string | null;
  gstPortalStatus?: string;
  duplicateOfDocumentId?: string | null;
  manuallyCorrected?: boolean;
  correctedBy?: string;
}

export async function updateDocumentFields(sql: Sql, tenantId: string, documentId: string, patch: DocumentUpdatePatch): Promise<DocumentRow> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  const entries: [string, unknown][] = [
    ["vendor_name", patch.vendorName], ["vendor_address", patch.vendorAddress], ["document_date", patch.documentDate],
    ["invoice_number", patch.invoiceNumber], ["raw_total_amount", patch.rawTotalAmount], ["tax_amount", patch.taxAmount],
    ["tax_identifier", patch.taxIdentifier], ["ocr_confidence_score", patch.ocrConfidenceScore],
    ["processing_status", patch.processingStatus], ["ocr_error_message", patch.ocrErrorMessage],
    ["reconciliation_score", patch.reconciliationScore], ["reconciliation_reason", patch.reconciliationReason],
    ["matched_bank_transaction_id", patch.matchedBankTransactionId], ["gst_portal_status", patch.gstPortalStatus],
    ["duplicate_of_document_id", patch.duplicateOfDocumentId],
  ];
  for (const [col, val] of entries) {
    if (val !== undefined) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (patch.manuallyCorrected !== undefined) {
    params.push(patch.manuallyCorrected, patch.correctedBy ?? null);
    sets.push(`manually_corrected = $${params.length - 1}`, `corrected_by = $${params.length}`, `corrected_at = now()`);
  }
  params.push(tenantId, documentId);
  const rows = await sql.unsafe<DocumentRow[]>(
    `update documents set ${sets.join(", ")} where tenant_id = $${params.length - 1} and document_id = $${params.length} returning ${SELECT}`,
    params as any[],
  );
  return rows[0]!;
}

// Duplicate detection: same tenant, same vendor + invoice number (or same
// amount+date if no invoice number), excluding the row itself.
export async function findDuplicateDocument(sql: Sql, tenantId: string, vendorName: string, invoiceNumber: string | null, rawTotalAmount: number | null, documentDate: string | null, excludeDocumentId: string): Promise<DocumentRow | null> {
  if (invoiceNumber) {
    const rows = await sql.unsafe<DocumentRow[]>(
      `select ${SELECT} from documents
       where tenant_id = $1 and vendor_name = $2 and invoice_number = $3 and document_id != $4
       limit 1`,
      [tenantId, vendorName, invoiceNumber, excludeDocumentId],
    );
    return rows[0] ?? null;
  }
  // No invoice number to key off — fall back to vendor + amount + date,
  // matching the Go original's extra documentDate parameter here.
  const rows = await sql.unsafe<DocumentRow[]>(
    `select ${SELECT} from documents
     where tenant_id = $1 and vendor_name = $2 and raw_total_amount = $3 and document_date = $4 and document_id != $5
     limit 1`,
    [tenantId, vendorName, rawTotalAmount, documentDate, excludeDocumentId],
  );
  return rows[0] ?? null;
}

// Docs that have been OCR'd (status PARSED) but not yet reconciled —
// this is exactly what HandleRunReconciliation re-queues.
export async function listUnreconciledDocuments(sql: Sql, tenantId: string): Promise<DocumentRow[]> {
  return sql.unsafe<DocumentRow[]>(
    `select ${SELECT} from documents where tenant_id = $1 and processing_status = 'PARSED' order by created_at asc`,
    [tenantId],
  );
}

// Every invoice with a non-empty tax_identifier — used both by GET
// /gst/vendor-status and cmd/worker's syncGSTPortal cross-verify. No
// date filtering in the Go original; filtering is left to the caller
// if it ever needs it.
export async function listInvoicesWithTaxIdentifier(sql: Sql, tenantId: string): Promise<DocumentRow[]> {
  return sql.unsafe<DocumentRow[]>(
    `select ${SELECT} from documents where tenant_id = $1 and tax_identifier is not null and tax_identifier != ''`,
    [tenantId],
  );
}

export async function listVendorNames(sql: Sql, tenantId: string): Promise<string[]> {
  const rows = await sql<{ vendorName: string }[]>`
    select distinct vendor_name as "vendorName" from documents
    where tenant_id = ${tenantId} and vendor_name is not null and vendor_name != ''
  `;
  return rows.map((r) => r.vendorName);
}

export async function countDocumentsByStatus(sql: Sql, tenantId: string, status: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`select count(*)::text from documents where tenant_id = ${tenantId} and processing_status = ${status}`;
  return parseInt(rows[0]!.count, 10);
}

export async function listByGSTStatus(sql: Sql, tenantId: string, gstPortalStatus: string): Promise<DocumentRow[]> {
  return sql.unsafe<DocumentRow[]>(
    `select ${SELECT} from documents where tenant_id = $1 and gst_portal_status = $2`,
    [tenantId, gstPortalStatus],
  );
}

export async function listAllForExport(sql: Sql, tenantId: string): Promise<DocumentRow[]> {
  return sql.unsafe<DocumentRow[]>(`select ${SELECT} from documents where tenant_id = $1 order by created_at asc`, [tenantId]);
}

// Keyset page for the report export. Rows from one bulk INSERT share created_at (same transaction timestamp), so the
// document_id tie-breaker is what makes the cursor total-ordered. The cursor carries created_at as TEXT: a JS Date
// would truncate Postgres' microseconds and skip or repeat rows at page boundaries.
export async function exportPage(sql: Sql, tenantId: string, cursor: { ts: string; id: string } | null, limit: number): Promise<{ rows: DocumentRow[]; next: { ts: string; id: string } | null }> {
  const rows = cursor
    ? await sql.unsafe<(DocumentRow & { cursorTs: string })[]>(
        `select ${SELECT}, created_at::text as "cursorTs" from documents
         where tenant_id = $1 and (created_at, document_id) > ($2::text::timestamptz, $3::uuid)
         order by created_at asc, document_id asc limit $4`, [tenantId, cursor.ts, cursor.id, limit])
    : await sql.unsafe<(DocumentRow & { cursorTs: string })[]>(
        `select ${SELECT}, created_at::text as "cursorTs" from documents where tenant_id = $1 order by created_at asc, document_id asc limit $2`, [tenantId, limit]);
  const last = rows[rows.length - 1];
  return { rows, next: rows.length === limit && last ? { ts: last.cursorTs, id: last.documentId } : null };
}

// Bulk insert in chunks: Postgres allows at most 65,534 bind parameters per statement, and a 5,000-row register
// with ~15 columns would otherwise need 75,000 (MAX_PARAMETERS_EXCEEDED → HTTP 500).
export interface NewDatasetDocument {
  tenantId: string; docType: "INVOICE" | "CREDIT_NOTE"; originalFilename: string;
  vendorName: string | null; documentDate: string; invoiceNumber: string | null; rawTotalAmount: number; taxAmount: number | null; taxIdentifier: string | null;
}
export async function bulkInsertDatasetDocuments(sql: Sql, docs: NewDatasetDocument[], chunk = 1500): Promise<number> {
  for (let i = 0; i < docs.length; i += chunk) {
    const values = docs.slice(i, i + chunk).map((d) => ({
      tenant_id: d.tenantId, doc_type: d.docType, original_filename: d.originalFilename, storage_key: "", mime_type: "text/tabular", file_size_bytes: 0,
      vendor_name: d.vendorName, document_date: d.documentDate, invoice_number: d.invoiceNumber, raw_total_amount: d.rawTotalAmount, tax_amount: d.taxAmount,
      tax_identifier: d.taxIdentifier, ingest_channel: "WEB_UPLOAD", processing_status: "PARSED", ocr_confidence_score: 1,
    }));
    await sql`insert into documents ${sql(values, "tenant_id", "doc_type", "original_filename", "storage_key", "mime_type", "file_size_bytes", "vendor_name", "document_date", "invoice_number", "raw_total_amount", "tax_amount", "tax_identifier", "ingest_channel", "processing_status", "ocr_confidence_score")}`;
  }
  return docs.length;
}

// Existing invoices in a date window — input to duplicate detection when a register is (re-)uploaded.
export interface ExistingInvoiceKey { vendorName: string | null; invoiceNumber: string | null; rawTotalAmount: string | null; documentDate: string | null; taxIdentifier: string | null }
export async function listExistingInvoiceKeys(sql: Sql, tenantId: string, fromDate: string, toDate: string): Promise<ExistingInvoiceKey[]> {
  return sql<ExistingInvoiceKey[]>`
    select vendor_name as "vendorName", invoice_number as "invoiceNumber", raw_total_amount::text as "rawTotalAmount", document_date as "documentDate", tax_identifier as "taxIdentifier"
    from documents where tenant_id = ${tenantId} and doc_type in ('INVOICE','CREDIT_NOTE') and document_date between ${fromDate} and ${toDate}`;
}

export async function listByStatus(sql: Sql, tenantId: string, status: string): Promise<DocumentRow[]> {
  return sql.unsafe<DocumentRow[]>(`select ${SELECT} from documents where tenant_id = $1 and processing_status = $2`, [tenantId, status]);
}
