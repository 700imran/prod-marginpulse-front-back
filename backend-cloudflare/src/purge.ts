// The actual purge logic behind data retention & deletion. Called from
// two places: index.ts's daily cron sweep (the normal path — see
// RETENTION in src/retention.ts for how long things wait before landing
// here), and routes/admin.ts's force-purge-now endpoint (for a support/
// compliance request that can't wait for the grace period).
//
// Every function here is safe to call more than once for the same
// target: a document or tenant that's already gone is treated as
// success, not an error, so a retried cron run or a retried admin call
// never fails on "already deleted."
import type { Env } from "./config";
import type { Sql } from "./db";
import { listDocumentsPendingPurge, hardDeleteDocumentRow, listAllForExport } from "./repository/documents";
import { listTenantsPendingPurge, getTenantById } from "./repository/tenants";
import { purgeOldAuditLogs as purgeOldAuditLogsQuery, appendAuditLog } from "./repository/auditLog";
import { deleteObject } from "./storage";
import { deleteSupabaseAuthUser } from "./auth/supabase";
import { setTenantContext } from "./security/tenantContext";
import { RETENTION } from "./retention";

export interface PurgeSummary {
  documentsPurged: number;
  documentsFailed: number;
  tenantsPurged: number;
  tenantsFailed: number;
  auditLogRowsPurged: number;
}

// Soft-deleted documents past their trash grace period: delete the R2
// object, then the row. R2 first, always — if the row delete happened
// first and the R2 delete then failed, the object would be orphaned with
// no row left pointing at it, unrecoverable. This way, a mid-purge crash
// leaves a document with no R2 object but a still-present (retriable) row
// instead.
export async function purgeExpiredDocuments(sql: Sql, env: Env): Promise<{ purged: number; failed: number }> {
  const cutoff = new Date(Date.now() - RETENTION.DOCUMENT_TRASH_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const pending = await listDocumentsPendingPurge(sql, cutoff);
  let purged = 0;
  let failed = 0;
  for (const doc of pending) {
    try {
      await setTenantContext(sql, doc.tenantId);
      await deleteObject(env, doc.storageKey);
      await hardDeleteDocumentRow(sql, doc.tenantId, doc.documentId);
      await appendAuditLog(sql, {
        tenantId: doc.tenantId, entityType: "DOCUMENT", entityId: doc.documentId,
        action: "PURGED", reason: `soft-deleted more than ${RETENTION.DOCUMENT_TRASH_GRACE_DAYS} days ago`,
        actorEmail: "system@marginpulse",
      });
      purged++;
    } catch (e) {
      failed++;
      console.error("document_purge_failed", { documentId: doc.documentId, tenantId: doc.tenantId, error: (e as Error).message });
    }
  }
  return { purged, failed };
}

// Tenants whose self-service (or admin-forced) deletion request has sat
// past the grace period: clean up every one of their R2 objects — not
// just already-soft-deleted ones, everything, since the whole account is
// going — then delete the Supabase auth user, which cascades through
// every tenant-owned Postgres table in one step (see db/schema.sql's `on
// delete cascade`s). R2 cleanup happens first for the same crash-safety
// reason as document purge: better to retry an R2 cleanup on a still-
// present tenant than to have cascaded away the only record of which R2
// keys belonged to it.
export async function purgeExpiredTenants(sql: Sql, env: Env): Promise<{ purged: number; failed: number }> {
  const cutoff = new Date(Date.now() - RETENTION.TENANT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const pending = await listTenantsPendingPurge(sql, cutoff);
  let purged = 0;
  let failed = 0;
  for (const tenant of pending) {
    try {
      await purgeTenantNow(sql, env, tenant.tenantId);
      purged++;
    } catch (e) {
      failed++;
      console.error("tenant_purge_failed", { tenantId: tenant.tenantId, error: (e as Error).message });
    }
  }
  return { purged, failed };
}

// The actual per-tenant purge, factored out so routes/admin.ts's
// force-purge-now endpoint can call exactly the same logic the scheduled
// sweep uses instead of a second, divergent implementation.
export async function purgeTenantNow(sql: Sql, env: Env, tenantId: string): Promise<void> {
  await setTenantContext(sql, tenantId);
  const tenant = await getTenantById(sql, tenantId);
  if (!tenant) return; // already gone — nothing to do, not an error

  const docs = await listAllForExport(sql, tenantId);
  for (const doc of docs) {
    try {
      await deleteObject(env, doc.storageKey);
    } catch (e) {
      // Log and continue rather than abort the whole tenant purge over
      // one already-missing or otherwise-failing R2 object — the
      // Supabase Admin API call below is what actually matters for
      // "the account and its data are gone"; a stray orphaned R2 object
      // is a follow-up cleanup, not a reason to leave the account intact.
      console.error("tenant_purge_r2_object_failed", { tenantId, storageKey: doc.storageKey, error: (e as Error).message });
    }
  }

  // No audit_log entry after this point — cascade deletes audit_log too
  // (tenant_id references tenants on delete cascade), so writing one
  // first is the only way this action leaves any record at all.
  await appendAuditLog(sql, {
    tenantId, entityType: "TENANT", entityId: tenantId, action: "PURGED",
    reason: "deletion grace period elapsed (or admin-forced)", actorEmail: "system@marginpulse",
  });
  await deleteSupabaseAuthUser(env, tenantId);
}

export async function purgeOldAuditLogs(sql: Sql): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION.AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return purgeOldAuditLogsQuery(sql, cutoff);
}

export async function runRetentionSweep(sql: Sql, env: Env): Promise<PurgeSummary> {
  const docs = await purgeExpiredDocuments(sql, env);
  const tenants = await purgeExpiredTenants(sql, env);
  const auditLogRowsPurged = await purgeOldAuditLogs(sql);
  return {
    documentsPurged: docs.purged, documentsFailed: docs.failed,
    tenantsPurged: tenants.purged, tenantsFailed: tenants.failed,
    auditLogRowsPurged,
  };
}
