import { jwtVerify } from "jose";
import type { Env } from "../config";
import type { Sql } from "../db";

// Replaces internal/security/jwt.go entirely, and most of
// httpapi/auth_handlers.go (HandleRegister/HandleLogin/HandleRefresh/
// HandleLogout no longer exist in this backend — the frontend calls
// Supabase Auth's own REST endpoints directly, via
// `@supabase/supabase-js`'s `signUp`/`signInWithPassword`/
// `signInWithOAuth('google' | 'apple')`/`refreshSession`, and sends the
// resulting `session.access_token` to us as a normal Bearer token).
//
// What's left for the Worker to do is exactly one thing: verify that
// token, then map it onto our own tenant row.
//
// Supabase signs access tokens HS256 with the project's JWT secret
// (Settings > API > JWT Secret) by default. If your project has been
// migrated to asymmetric (ES256) signing keys, swap jwtVerify's key
// argument for `createRemoteJWKSet(new URL(env.SUPABASE_URL + "/auth/v1/.well-known/jwks.json"))`
// instead — same call shape, jose supports both.

export interface SupabaseClaims {
  sub: string; // Supabase auth.users.id — this IS our tenant_id
  email: string;
  role: string; // "authenticated"
  exp: number;
}

export async function verifySupabaseToken(env: Env, bearerToken: string): Promise<SupabaseClaims> {
  const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  const { payload } = await jwtVerify(bearerToken, secret, {
    issuer: `${env.SUPABASE_URL}/auth/v1`,
  });
  if (!payload.sub || !payload.email) {
    throw new Error("Supabase token missing sub/email claim");
  }
  return {
    sub: payload.sub,
    email: payload.email as string,
    role: (payload.role as string) ?? "authenticated",
    exp: payload.exp!,
  };
}

export interface TenantContext {
  tenantId: string;
  ownerEmail: string;
  businessName: string;
  planTier: string;
  isActive: boolean;
  isPlatformAdmin: boolean;
  gstinNumber: string | null;
}

// Loads the tenants row for a verified Supabase user, creating it on
// first sight as a fallback in case the `on_auth_user_created` DB
// trigger (db/schema.sql) hasn't fired yet or was never installed. This
// mirrors what HandleRegister used to do, minus password handling.
export async function loadOrCreateTenant(sql: Sql, claims: SupabaseClaims): Promise<TenantContext> {
  const fallbackName = claims.email.split("@")[0] ?? claims.email;
  const rows = await sql<TenantContext[]>`
    insert into tenants (tenant_id, business_name, owner_email)
    values (${claims.sub}, ${fallbackName}, ${claims.email})
    on conflict (tenant_id) do update set owner_email = excluded.owner_email
    returning
      tenant_id as "tenantId",
      owner_email as "ownerEmail",
      business_name as "businessName",
      plan_tier as "planTier",
      is_active as "isActive",
      is_platform_admin as "isPlatformAdmin",
      gstin_number as "gstinNumber"
  `;
  return rows[0]!;
}
