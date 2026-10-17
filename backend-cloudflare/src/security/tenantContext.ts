// Session-variable helpers backing the Row-Level Security policies added
// to db/schema.sql. RLS reads these via two SQL functions
// (app_current_tenant_id(), app_is_privileged()) defined in that file —
// this module is the only place application code should set them, so
// there's exactly one place to audit for "what can bypass tenant
// isolation and why."
//
// IMPORTANT: none of this has any effect unless the Worker's Hyperdrive
// connection uses the non-superuser `app_user` role created in
// db/schema.sql, and unless src/db.ts's getDb() uses max:1 (one physical
// connection per request, so a SET made here is guaranteed to apply to
// every later query in the same request — see that file's comment).
import type { Sql } from "../db";

// Scopes every later query on this connection to exactly one tenant's
// rows. Call this as soon as a request or queue task knows which tenant
// it's acting for, before any other query touches a tenant-owned table.
export async function setTenantContext(sql: Sql, tenantId: string): Promise<void> {
  await sql`select set_config('app.tenant_id', ${tenantId}, false)`;
}

export interface PrivilegedContextOptions {
  // A real authenticated user whose own tenant row has
  // is_platform_admin = true. Set on every request from that user (see
  // middleware/auth.ts) — routes/admin.ts's requirePlatformAdmin
  // middleware remains the actual gate on which routes they can reach;
  // this only affects what the database additionally allows once
  // they're on one.
  platformAdmin?: boolean;
  // Trusted server-only code with no single caller-tenant to scope to:
  // a webhook payload already authorized by a signature/secret check,
  // an invite-token redemption authorized by possession of the token
  // itself, or the cron sweep that must enumerate every tenant. Never
  // set this from a code path a client can reach without first passing
  // a signature/secret/token check — it is a full cross-tenant bypass.
  system?: boolean;
}

export async function setPrivilegedContext(sql: Sql, opts: PrivilegedContextOptions): Promise<void> {
  if (opts.platformAdmin !== undefined) {
    await sql`select set_config('app.is_platform_admin', ${String(opts.platformAdmin)}, false)`;
  }
  if (opts.system !== undefined) {
    await sql`select set_config('app.system_context', ${String(opts.system)}, false)`;
  }
}
