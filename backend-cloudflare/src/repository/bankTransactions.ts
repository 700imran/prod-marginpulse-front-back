import type { Sql } from "../db";

export interface BankTransactionRow {
  transactionId: string;
  tenantId: string;
  bankReference: string | null;
  narration: string | null;
  transactionDate: string;
  debitAmount: string;
  creditAmount: string;
  reconciliationStatus: string;
  matchedDocumentId: string | null;
  matchScore: string | null;
  bankName: string | null;
}

const SELECT = `
  transaction_id as "transactionId", tenant_id as "tenantId", bank_reference as "bankReference",
  narration, transaction_date as "transactionDate", debit_amount as "debitAmount", credit_amount as "creditAmount",
  reconciliation_status as "reconciliationStatus", matched_document_id as "matchedDocumentId",
  match_score as "matchScore", bank_name as "bankName"
`;

export interface NewBankTransaction {
  tenantId: string;
  bankReference?: string;
  narration?: string;
  transactionDate: string;
  debitAmount: number;
  creditAmount: number;
  bankName?: string;
  sourceFilename?: string;
}

// Bulk insert for CSV upload (internal/httpapi/reconciliation_handlers.go's
// HandleBankCSVUpload). One multi-row INSERT beats N round trips —
// postgres.js's sql(array, ...columns) helper builds the column list
// and VALUES rows together.
export async function bulkInsertBankTransactions(sql: Sql, rows: NewBankTransaction[], chunk = 1500): Promise<number> {
  if (rows.length === 0) return 0;
  // Chunked: one statement may carry at most 65,534 bind parameters.
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows.slice(i, i + chunk).map((r) => ({
      tenant_id: r.tenantId,
      bank_reference: r.bankReference ?? null,
      narration: r.narration ?? null,
      transaction_date: r.transactionDate,
      debit_amount: r.debitAmount,
      credit_amount: r.creditAmount,
      bank_name: r.bankName ?? null,
      source_filename: r.sourceFilename ?? null,
    }));
    await sql`insert into bank_transactions ${sql(values, "tenant_id", "bank_reference", "narration", "transaction_date", "debit_amount", "credit_amount", "bank_name", "source_filename")}`;
  }
  return rows.length;
}

export async function listUnmatchedBankTransactions(sql: Sql, tenantId: string): Promise<BankTransactionRow[]> {
  return sql.unsafe<BankTransactionRow[]>(
    `select ${SELECT} from bank_transactions where tenant_id = $1 and reconciliation_status = 'UNMATCHED' order by transaction_date asc`,
    [tenantId],
  );
}

export async function markTransactionMatched(sql: Sql, tenantId: string, transactionId: string, documentId: string, score: number): Promise<void> {
  await sql`
    update bank_transactions set reconciliation_status = 'MATCHED', matched_document_id = ${documentId}, match_score = ${score}
    where tenant_id = ${tenantId} and transaction_id = ${transactionId}
  `;
}

// Bank rows a single document may be matched against: unmatched rows in its date window, plus any row ALREADY matched to this
// same document. The second part makes a redelivered task idempotent — it sees (and re-confirms) its own earlier claim instead of
// concluding "no candidate" and undoing the match. (Served by idx_banktx_matched_document.)
export async function listReconciliationCandidates(sql: Sql, tenantId: string, fromDate: string, toDate: string, documentId: string): Promise<BankTransactionRow[]> {
  return sql.unsafe<BankTransactionRow[]>(
    `(select ${SELECT} from bank_transactions where tenant_id = $1 and reconciliation_status = 'UNMATCHED' and transaction_date between $2 and $3)
     union all
     (select ${SELECT} from bank_transactions where tenant_id = $1 and matched_document_id = $4 and reconciliation_status = 'MATCHED')`,
    [tenantId, fromDate, toDate, documentId],
  );
}

// Atomically claims a bank row for a document: succeeds only if the row is still UNMATCHED (or is already this document's, so a
// retry is harmless). Two documents reconciled at the same moment can both SEE the same unmatched row; exactly one claim wins.
export async function claimTransactionForDocument(sql: Sql, tenantId: string, transactionId: string, documentId: string, score: number): Promise<boolean> {
  const rows = await sql`
    update bank_transactions set reconciliation_status = 'MATCHED', matched_document_id = ${documentId}, match_score = ${score}
    where tenant_id = ${tenantId} and transaction_id = ${transactionId}
      and (reconciliation_status = 'UNMATCHED' or matched_document_id = ${documentId})
    returning 1 as ok`;
  return rows.length === 1;
}

export async function listBankTransactionsByTenant(sql: Sql, tenantId: string, status: string | undefined, limit: number, offset: number): Promise<BankTransactionRow[]> {
  if (status) {
    return sql.unsafe<BankTransactionRow[]>(
      `select ${SELECT} from bank_transactions where tenant_id = $1 and reconciliation_status = $2 order by transaction_date desc limit $3 offset $4`,
      [tenantId, status, limit, offset],
    );
  }
  return sql.unsafe<BankTransactionRow[]>(
    `select ${SELECT} from bank_transactions where tenant_id = $1 order by transaction_date desc limit $2 offset $3`,
    [tenantId, limit, offset],
  );
}

export async function listUnmatchedInDateRange(sql: Sql, tenantId: string, fromDate: string, toDate: string): Promise<BankTransactionRow[]> {
  return sql.unsafe<BankTransactionRow[]>(
    `select ${SELECT} from bank_transactions
     where tenant_id = $1 and reconciliation_status = 'UNMATCHED' and transaction_date between $2 and $3`,
    [tenantId, fromDate, toDate],
  );
}

/**
 * Tenants that could possibly have a "paid but no invoice" anomaly: an old UNMATCHED debit AND at least one vendor name on
 * file. Keyset-paginated (stable under concurrent inserts, uses idx_banktx_tenant_status_date), so the daily sweep touches
 * only tenants with work to do instead of every tenant ever created.
 *
 * The query walks the tenants table and asks "does this tenant have at least one such row?" with two EXISTS probes, so the
 * cost of a page is proportional to the tenants on it. The earlier form (SELECT DISTINCT over bank_transactions, then an
 * EXISTS per bank row) did one documents lookup per UNMATCHED debit: on a 1,500-tenant test set the first page of 500 read
 * 222,000 buffers and took 116 ms; this form reads 3,500 and takes 9 ms. Same result set (verified row-for-row).
 */
export async function listMissingInvoiceCandidateTenants(sql: Sql, cutoffDate: string, afterTenantId: string | null, limit: number): Promise<string[]> {
  const rows = await sql<{ tenantId: string }[]>`
    select t.tenant_id as "tenantId" from tenants t
    where t.tenant_id > ${afterTenantId ?? "00000000-0000-0000-0000-000000000000"}
      and exists (select 1 from bank_transactions b where b.tenant_id = t.tenant_id and b.reconciliation_status = 'UNMATCHED' and b.debit_amount > 0 and b.transaction_date <= ${cutoffDate})
      and exists (select 1 from documents d where d.tenant_id = t.tenant_id and d.vendor_name is not null and d.vendor_name <> '')
    order by t.tenant_id limit ${limit}`;
  return rows.map((r) => r.tenantId);
}
