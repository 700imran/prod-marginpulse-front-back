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
    algorithms: ["RS256"],
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
  isActive: boolean;
  isPlatformAdmin: boolean;
  gstinNumber: string | null;
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
      plan_tier as "planTier",
      is_active as "isActive",
      is_platform_admin as "isPlatformAdmin",
      gstin_number as "gstinNumber"
  `;

  return rows[0]!;
}
