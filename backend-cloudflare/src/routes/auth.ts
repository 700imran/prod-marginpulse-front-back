import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { updateTenantProfile, requestTenantDeletion, cancelTenantDeletion } from "../repository/tenants";
import { appendAuditLog } from "../repository/auditLog";
import { sendAccountDeletionScheduled, sendAccountDeletionCancelled } from "../email";
import { apiError } from "../http";
import { RETENTION } from "../retention";

// What used to be here in auth_handlers.go — HandleRegister, HandleLogin,
// HandleRefresh, HandleLogout, HandleChangePassword — is gone. The
// frontend now calls Supabase Auth's own endpoints directly for all of
// that (via @supabase/supabase-js's signUp/signInWithPassword/
// signInWithOAuth/refreshSession/signOut/updateUser). All that's left
// for this API is reading and updating the tenant profile row.

export const authRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

authRoutes.use("*", requireAuth);

authRoutes.get("/me", (c) => c.json(c.get("tenant")));

authRoutes.patch("/me", async (c) => {
  const patch = await c.req.json();
  const tenant = c.get("tenant");
  const updated = await updateTenantProfile(c.get("sql"), tenant.tenantId, patch);
  await appendAuditLog(c.get("sql"), {
    tenantId: tenant.tenantId,
    entityType: "TENANT",
    entityId: tenant.tenantId,
    action: "PROFILE_UPDATED",
    actorEmail: tenant.ownerEmail,
  });
  return c.json(updated);
});

// DELETE /me — request account deletion. Reversible for
// RETENTION.TENANT_DELETION_GRACE_DAYS (src/retention.ts); the account
// stays fully usable during that window (see db/schema.sql's comment on
// tenants.deletion_requested_at). The cron sweep in index.ts actually
// deletes everything once the grace period elapses — see src/purge.ts.
authRoutes.delete("/me", async (c) => {
  const sql = c.get("sql");
  const tenant = c.get("tenant");
  if (tenant.deletionRequestedAt) {
    return apiError(c, 409, "CONFLICT", "Account deletion is already scheduled");
  }
  await requestTenantDeletion(sql, tenant.tenantId);
  const purgeDate = new Date(Date.now() + RETENTION.TENANT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  await appendAuditLog(sql, {
    tenantId: tenant.tenantId, entityType: "TENANT", entityId: tenant.tenantId,
    action: "DELETION_REQUESTED", actorEmail: tenant.ownerEmail,
  });
  await sendAccountDeletionScheduled(c.env, tenant.ownerEmail, tenant.businessName, purgeDate.toDateString()).catch((e) =>
    console.error("deletion_scheduled_email_failed", { tenantId: tenant.tenantId, error: (e as Error).message }),
  );
  return c.json({ status: "DELETION_SCHEDULED", purge_date: purgeDate.toISOString() });
});

authRoutes.post("/me/cancel-deletion", async (c) => {
  const sql = c.get("sql");
  const tenant = c.get("tenant");
  if (!tenant.deletionRequestedAt) {
    return apiError(c, 400, "VALIDATION_ERROR", "No account deletion is currently scheduled");
  }
  await cancelTenantDeletion(sql, tenant.tenantId);
  await appendAuditLog(sql, {
    tenantId: tenant.tenantId, entityType: "TENANT", entityId: tenant.tenantId,
    action: "DELETION_CANCELLED", actorEmail: tenant.ownerEmail,
  });
  await sendAccountDeletionCancelled(c.env, tenant.ownerEmail, tenant.businessName).catch((e) =>
    console.error("deletion_cancelled_email_failed", { tenantId: tenant.tenantId, error: (e as Error).message }),
  );
  return c.json({ status: "ACTIVE" });
});
