import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../config";
import type { Sql } from "../db";

// Supabase access tokens are verified using Supabase's JWKS endpoint.
//
// This supports asymmetric JWT signing such as RS256.
// The JWKS endpoint publishes the public keys corresponding to the
// signing keys used by Supabase Auth.
//
// The frontend obtains the access token from Supabase Auth and sends it
// to this Worker as:
//
//   Authorization: Bearer <access_token>
//
// The Worker verifies the token, then maps the Supabase auth user
// (claims.sub) onto our local tenants table.

// -----------------------------------------------------------------------------
// Supabase JWT claims
// -----------------------------------------------------------------------------

export interface SupabaseClaims {
  sub: string; // Supabase auth.users.id — this IS our tenant_id
  email: string;
  role: string; // normally "authenticated"
  exp: number;
}

// -----------------------------------------------------------------------------
// Supabase JWKS
// -----------------------------------------------------------------------------
//
// Supabase publishes its public signing keys here:
//
//   https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
//
// createRemoteJWKSet() automatically selects the correct public key based
// on the JWT "kid" header and caches/fetches keys as needed.
//

function getSupabaseJWKS(env: Env) {
  return createRemoteJWKSet(
    new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
  );
}

// -----------------------------------------------------------------------------
// Verify Supabase access token
// -----------------------------------------------------------------------------

export async function verifySupabaseToken(
  env: Env,
  bearerToken: string
): Promise<SupabaseClaims> {
  const JWKS = getSupabaseJWKS(env);

  const { payload } = await jwtVerify(bearerToken, JWKS, {
    issuer: `${env.SUPABASE_URL}/auth/v1`,
    algorithms: ["RS256", "ES256"],
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

// -----------------------------------------------------------------------------
// Tenant context
// -----------------------------------------------------------------------------

export interface TenantContext {
  tenantId: string;
  ownerEmail: string;
  businessName: string;
  planTier: string;
  planExpiresAt?: string | null; // when a purchased plan lapses (it then reads as FREE); null = no expiry
  isActive: boolean;
  isPlatformAdmin: boolean;
  gstinNumber: string | null;
  deletionRequestedAt: string | null;
}

// -----------------------------------------------------------------------------
// Load or create tenant
// -----------------------------------------------------------------------------
//
// Maps the verified Supabase user to our local tenants row.
//
// If the tenant does not exist yet, create it as a fallback in case the
// on_auth_user_created database trigger has not fired.
//

export async function loadOrCreateTenant(
  sql: Sql,
  claims: SupabaseClaims
): Promise<TenantContext> {
  const fallbackName =
    claims.email.split("@")[0] ?? claims.email;

  const rows = await sql<TenantContext[]>`
    insert into tenants (tenant_id, business_name, owner_email)
    values (${claims.sub}, ${fallbackName}, ${claims.email})
    on conflict (tenant_id)
    do update set owner_email = excluded.owner_email
    returning
      tenant_id as "tenantId",
      owner_email as "ownerEmail",
      business_name as "businessName",
      case when plan_expires_at is not null and plan_expires_at <= now() then 'FREE' else plan_tier end as "planTier",
      plan_expires_at as "planExpiresAt",
      is_active as "isActive",
      is_platform_admin as "isPlatformAdmin",
      gstin_number as "gstinNumber",
      deletion_requested_at as "deletionRequestedAt"
  `;

  return rows[0]!;
}

// --- Supabase Admin API (src/purge.ts, hard account deletion) -------------
//
// The only place this codebase touches the Supabase Admin API rather than
// verifying a user-supplied JWT. Deleting the auth.users row this way
// (rather than a raw SQL DELETE against auth.users, which app_user has no
// access to anyway) goes through Supabase's own Auth service so its
// internal bookkeeping (sessions, refresh tokens) is cleaned up correctly
// — and it's what actually triggers the `on delete cascade` on
// tenants.tenant_id, which cascades through every tenant-owned table in
// one step. Never call this without having already deleted the tenant's
// R2 objects first — see src/purge.ts.
export async function deleteSupabaseAuthUser(env: Env, tenantId: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${tenantId}`, {
    method: "DELETE",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  // 404 means the auth user is already gone (a retried purge run, or it
  // was removed some other way) — treat that as success so this stays
  // safely retryable, same as every idempotent operation elsewhere in
  // this codebase.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase Admin API delete-user failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
