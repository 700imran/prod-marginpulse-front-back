import { invalidateTenantCache } from "../auth/supabase";
import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { pickValid, GSTIN_RE, PHONE_RE, COUNTRY_RE, type Schema } from "../security/validate";
import { updateTenantProfile } from "../repository/tenants";
import { appendAuditLog } from "../repository/auditLog";

// What used to be here in auth_handlers.go — HandleRegister, HandleLogin,
// HandleRefresh, HandleLogout, HandleChangePassword — is gone. The
// frontend now calls Supabase Auth's own endpoints directly for all of
// that (via @supabase/supabase-js's signUp/signInWithPassword/
// signInWithOAuth/refreshSession/signOut/updateUser). All that's left
// for this API is reading and updating the tenant profile row.

const PROFILE_SCHEMA: Schema = {
  businessName: { t: "str", max: 200 },
  displayName: { t: "str", max: 120 },
  phoneNumber: { t: "str", max: 16, pattern: PHONE_RE },
  countryCode: { t: "str", max: 2, pattern: COUNTRY_RE },
  gstinNumber: { t: "str", max: 15, pattern: GSTIN_RE },
  gstRegistered: { t: "bool" },
};

export const authRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

authRoutes.use("*", requireAuth);

authRoutes.get("/me", (c) => c.json(c.get("tenant")));

authRoutes.patch("/me", async (c) => {
  const patch = pickValid(await c.req.json().catch(() => null), PROFILE_SCHEMA);
  const tenant = c.get("tenant");
  const updated = await updateTenantProfile(c.get("sql"), tenant.tenantId, patch);
  invalidateTenantCache(tenant.tenantId);
  await appendAuditLog(c.get("sql"), {
    tenantId: tenant.tenantId,
    entityType: "TENANT",
    entityId: tenant.tenantId,
    action: "PROFILE_UPDATED",
    actorEmail: tenant.ownerEmail,
  });
  return c.json(updated);
});
