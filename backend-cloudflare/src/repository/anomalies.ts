import type { Sql } from "../db";

export interface AnomalyRow {
  anomalyId: string;
  tenantId: string;
  documentId: string | null;
  relatedTransactionId: string | null;
  anomalyType: string;
  severity: string;
  description: string;
  suggestedAction: string | null;
  status: string;
  createdAt: string;
}

const SELECT = `
  anomaly_id as "anomalyId", tenant_id as "tenantId", document_id as "documentId",
  related_transaction_id as "relatedTransactionId", anomaly_type as "anomalyType", severity,
  description, suggested_action as "suggestedAction", status, created_at as "createdAt"
`;

export async function createAnomaly(
  sql: Sql,
  input: { tenantId: string; documentId?: string; relatedTransactionId?: string; anomalyType: string; severity: string; description: string; suggestedAction?: string },
): Promise<AnomalyRow> {
  const rows = await sql.unsafe<AnomalyRow[]>(
    `insert into anomalies (tenant_id, document_id, related_transaction_id, anomaly_type, severity, description, suggested_action)
     values ($1,$2,$3,$4,$5,$6,$7) returning ${SELECT}`,
    [input.tenantId, input.documentId ?? null, input.relatedTransactionId ?? null, input.anomalyType, input.severity, input.description, input.suggestedAction ?? null],
  );
  return rows[0]!;
}

export async function listAnomalies(sql: Sql, tenantId: string, status: string | undefined, limit: number, offset: number): Promise<AnomalyRow[]> {
  if (status) {
    return sql.unsafe<AnomalyRow[]>(`select ${SELECT} from anomalies where tenant_id = $1 and status = $2 order by created_at desc limit $3 offset $4`, [tenantId, status, limit, offset]);
  }
  return sql.unsafe<AnomalyRow[]>(`select ${SELECT} from anomalies where tenant_id = $1 order by created_at desc limit $2 offset $3`, [tenantId, limit, offset]);
}

export async function resolveAnomaly(sql: Sql, tenantId: string, anomalyId: string, status: "RESOLVED" | "DISMISSED", resolvedBy: string): Promise<void> {
  await sql`update anomalies set status = ${status}, resolved_at = now(), resolved_by = ${resolvedBy} where tenant_id = ${tenantId} and anomaly_id = ${anomalyId}`;
}

export async function countOpenAnomaliesBySeverity(sql: Sql, tenantId: string): Promise<Record<string, number>> {
  const rows = await sql<{ severity: string; count: string }[]>`
    select severity, count(*)::text from anomalies where tenant_id = ${tenantId} and status = 'OPEN' group by severity
  `;
  return Object.fromEntries(rows.map((r) => [r.severity, parseInt(r.count, 10)]));
}

export async function existsOpenForRelatedTransaction(sql: Sql, tenantId: string, transactionId: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists(
      select 1 from anomalies where tenant_id = ${tenantId} and related_transaction_id = ${transactionId} and status = 'OPEN'
    ) as "exists"
  `;
  return rows[0]!.exists;
}

export async function getAnomalyById(sql: Sql, tenantId: string, anomalyId: string): Promise<AnomalyRow | null> {
  const rows = await sql.unsafe<AnomalyRow[]>(`select ${SELECT} from anomalies where tenant_id = $1 and anomaly_id = $2`, [tenantId, anomalyId]);
  return rows[0] ?? null;
}
