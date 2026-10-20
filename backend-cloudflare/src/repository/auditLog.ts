import type { Sql } from "../db";

export interface AuditLogRow {
  auditLogId: string;
  entityType: string;
  entityId: string;
  action: string;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  actorEmail: string;
  createdAt: string;
}

export async function appendAuditLog(
  sql: Sql,
  input: { tenantId: string; entityType: string; entityId: string; action: string; fieldName?: string; oldValue?: string; newValue?: string; reason?: string; actorEmail: string },
): Promise<void> {
  await sql`
    insert into audit_log (tenant_id, entity_type, entity_id, action, field_name, old_value, new_value, reason, actor_email)
    values (${input.tenantId}, ${input.entityType}, ${input.entityId}, ${input.action}, ${input.fieldName ?? null}, ${input.oldValue ?? null}, ${input.newValue ?? null}, ${input.reason ?? null}, ${input.actorEmail})
  `;
}

export async function listAuditLogForEntity(sql: Sql, tenantId: string, entityType: string, entityId: string): Promise<AuditLogRow[]> {
  return sql<AuditLogRow[]>`
    select
      audit_log_id as "auditLogId", entity_type as "entityType", entity_id as "entityId", action,
      field_name as "fieldName", old_value as "oldValue", new_value as "newValue", reason,
      actor_email as "actorEmail", created_at as "createdAt"
    from audit_log
    where tenant_id = ${tenantId} and entity_type = ${entityType} and entity_id = ${entityId}
    order by created_at desc
  `;
}

// Tenant-wide listing for the Audit Trail screen. Filters are optional and
// always parameterized; the limit is clamped here as well as in the route.
export async function listAuditLog(
  sql: Sql, tenantId: string, opts: { entityType?: string; entityId?: string; limit?: number } = {},
): Promise<AuditLogRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), 200);
  return sql<AuditLogRow[]>`
    select
      audit_log_id as "auditLogId", entity_type as "entityType", entity_id as "entityId", action,
      field_name as "fieldName", old_value as "oldValue", new_value as "newValue", reason,
      actor_email as "actorEmail", created_at as "createdAt"
    from audit_log
    where tenant_id = ${tenantId}
      ${opts.entityType ? sql`and entity_type = ${opts.entityType}` : sql``}
      ${opts.entityId ? sql`and entity_id = ${opts.entityId}` : sql``}
    order by created_at desc
    limit ${limit}
  `;
}

// Retention purge (src/purge.ts) — audit_log rows carry no secrets (see
// this file's own values: field_name/old_value/new_value are business
// data, never passwords/tokens/OTPs), so this is a plain age-based
// delete, no per-row inspection needed. Runs under system_context, same
// as the rest of the cron sweep — this is intentionally cross-tenant in
// one statement rather than tenant-by-tenant, since there's no per-row
// action to take other than deleting it.
export async function purgeOldAuditLogs(sql: Sql, olderThan: Date): Promise<number> {
  const result = await sql`delete from audit_log where created_at <= ${olderThan.toISOString()}`;
  return result.count;
}
