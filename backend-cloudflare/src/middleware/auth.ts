import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { verifySupabaseToken, loadOrCreateTenant, type TenantContext } from "../auth/supabase";

// Replaces middleware.go's RequireAuth. Supabase issues and rotates the
// token itself, so there's no blocklist check here — signing out is
// Supabase's problem now, not ours. Must run after withDb (uses c.get("sql")).
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }> = async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  let claims;
  try {
    claims = await verifySupabaseToken(c.env, match[1]!);
  } catch {
    return c.json({ error: "invalid or expired token" }, 401);
  }

  const tenant = await loadOrCreateTenant(c.get("sql"), claims);
  if (!tenant.isActive) {
    return c.json({ error: "account is deactivated" }, 403);
  }
  c.set("tenant", tenant);
  await next();
};

export const requirePlatformAdmin: MiddlewareHandler<{ Variables: { tenant: TenantContext } }> = async (c, next) => {
  const tenant = c.get("tenant");
  if (!tenant?.isPlatformAdmin) {
    return c.json({ error: "platform admin access required" }, 403);
  }
  await next();
};
