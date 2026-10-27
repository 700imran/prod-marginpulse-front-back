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

// Cached per isolate: creating a new remote JWKS on every request threw away
// jose's key cache and added a network round trip to Supabase to EVERY call.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getSupabaseJWKS(env: Env) {
  const url = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    jwksCache.set(url, jwks);
  }
  return jwks;
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
    audience: "authenticated", // rejects anon / service-role style tokens
    algorithms: ["RS256", "ES256"],
    clockTolerance: 5,
  });

  if (!payload.sub || !payload.email) {
    throw new Error("Supabase token missing sub/email claim");
  }
  if (payload.role !== undefined && payload.role !== "authenticated") {
    throw new Error("token role is not authenticated");
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

const TENANT_COLS = `
      tenant_id as "tenantId", owner_email as "ownerEmail", business_name as "businessName",
      plan_tier as "planTier", is_active as "isActive", is_platform_admin as "isPlatformAdmin",
      gstin_number as "gstinNumber"`;

// Returns null when this Supabase user has no tenant row yet.
export async function loadTenant(sql: Sql, claims: SupabaseClaims): Promise<TenantContext | null> {
  const rows = await sql.unsafe<TenantContext[]>(`select ${TENANT_COLS} from tenants where tenant_id = $1`, [claims.sub]);
  const t = rows[0];
  if (!t) return null;
  if (t.ownerEmail !== claims.email) {
    // only write when the email actually changed (was an UPDATE on every request before)
    await sql`update tenants set owner_email = ${claims.email} where tenant_id = ${claims.sub}`;
    t.ownerEmail = claims.email;
  }
  return t;
}

export async function createTenant(sql: Sql, claims: SupabaseClaims): Promise<TenantContext> {
  const fallbackName = claims.email.split("@")[0] ?? claims.email;
  await sql`
    insert into tenants (tenant_id, business_name, owner_email)
    values (${claims.sub}, ${fallbackName}, ${claims.email})
    on conflict (tenant_id) do nothing`;
  const rows = await sql.unsafe<TenantContext[]>(`select ${TENANT_COLS} from tenants where tenant_id = $1`, [claims.sub]);
  return rows[0]!;
}

// Kept for callers that want the old behaviour.
export async function loadOrCreateTenant(sql: Sql, claims: SupabaseClaims): Promise<TenantContext> {
  return (await loadTenant(sql, claims)) ?? (await createTenant(sql, claims));
}
