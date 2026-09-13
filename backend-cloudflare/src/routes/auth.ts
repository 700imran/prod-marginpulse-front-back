import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { updateTenantProfile } from "../repository/tenants";
import { appendAuditLog } from "../repository/auditLog";

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
