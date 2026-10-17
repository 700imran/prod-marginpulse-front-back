import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { verifySupabaseToken, loadOrCreateTenant, type TenantContext } from "../auth/supabase";
import { setTenantContext, setPrivilegedContext } from "../security/tenantContext";
import { apiError } from "../http";

// Replaces middleware.go's RequireAuth. Supabase issues and rotates the
// token itself, so there's no blocklist check here — signing out is
// Supabase's problem now, not ours. Must run after withDb (uses c.get("sql")).
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }> = async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return apiError(c, 401, "UNAUTHENTICATED", "missing bearer token");
  }
  let claims;
  try {
    claims = await verifySupabaseToken(c.env, match[1]!);
  } catch {
    return apiError(c, 401, "UNAUTHENTICATED", "invalid or expired token");
  }

  const sql = c.get("sql");
  // Set *before* loadOrCreateTenant: on a brand-new signup that row
  // doesn't exist yet, and the upsert inside loadOrCreateTenant is
  // itself subject to Row-Level Security (see db/schema.sql) — the
  // verified JWT's own subject claim is what the new row's tenant_id
  // will be, so it's safe to trust here even before the row exists.
  await setTenantContext(sql, claims.sub);
  const tenant = await loadOrCreateTenant(sql, claims);
  if (!tenant.isActive) {
    return apiError(c, 403, "FORBIDDEN", "account is deactivated");
  }
  // Re-set defensively from the loaded row (always equal to claims.sub in
  // practice) and mark platform-admin status for the rest of this
  // request. requirePlatformAdmin below remains the actual gate on which
  // *routes* an admin can reach — this only affects what the database
  // additionally allows once they're on one.
  await setTenantContext(sql, tenant.tenantId);
  await setPrivilegedContext(sql, { platformAdmin: tenant.isPlatformAdmin });
  c.set("tenant", tenant);
  await next();
};

export const requirePlatformAdmin: MiddlewareHandler<{ Variables: { tenant: TenantContext } }> = async (c, next) => {
  const tenant = c.get("tenant");
  if (!tenant?.isPlatformAdmin) {
    return apiError(c, 403, "FORBIDDEN", "platform admin access required");
  }
  await next();
};
