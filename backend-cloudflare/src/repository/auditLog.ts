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
