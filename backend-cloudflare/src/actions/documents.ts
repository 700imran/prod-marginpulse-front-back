// Shared by routes/documents.ts (DELETE /:id, POST /:id/restore) and the
// assistant's confirmed `soft_delete_document` / `restore_document`
// actions, so both write the identical audit_log row. `reason` is the only
// thing that differs: the assistant passes "via assistant: <tool>" so an
// assistant-mediated change is as traceable as a button click
// (backend-cloudflare/WORKFLOW.md, "Audit trail").
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { softDeleteDocument, restoreDocument, type DocumentRow } from "../repository/documents";
import { appendAuditLog } from "../repository/auditLog";

export async function trashDocument(sql: Sql, tenant: TenantContext, documentId: string, reason?: string): Promise<DocumentRow | null> {
  const doc = await softDeleteDocument(sql, tenant.tenantId, documentId);
  if (!doc) return null;
  await appendAuditLog(sql, { tenantId: tenant.tenantId, entityType: "DOCUMENT", entityId: documentId, action: "DELETED", reason, actorEmail: tenant.ownerEmail });
  return doc;
}

export async function untrashDocument(sql: Sql, tenant: TenantContext, documentId: string, reason?: string): Promise<DocumentRow | null> {
  const doc = await restoreDocument(sql, tenant.tenantId, documentId);
  if (!doc) return null;
  await appendAuditLog(sql, { tenantId: tenant.tenantId, entityType: "DOCUMENT", entityId: documentId, action: "RESTORED", reason, actorEmail: tenant.ownerEmail });
  return doc;
}
