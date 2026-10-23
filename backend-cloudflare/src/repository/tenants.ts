import type { Sql } from "../db";

export interface Tenant {
  tenantId: string;
  businessName: string;
  displayName: string | null;
  ownerEmail: string;
  phoneNumber: string | null;
  countryCode: string;
  whatsappBindingPhone: string | null;
  ingestEmailAlias: string | null;
  gstinNumber: string | null;
  gstRegistered: boolean;
  planTier: string;
  planExpiresAt: string | null;
  isActive: boolean;
  isPlatformAdmin: boolean;
  deletionRequestedAt: string | null;
  createdAt: string;
}

const SELECT = `
  tenant_id as "tenantId", business_name as "businessName", display_name as "displayName",
  owner_email as "ownerEmail", phone_number as "phoneNumber", country_code as "countryCode",
  whatsapp_binding_phone as "whatsappBindingPhone", ingest_email_alias as "ingestEmailAlias",
  gstin_number as "gstinNumber", gst_registered as "gstRegistered",
  case when plan_expires_at is not null and plan_expires_at <= now() then 'FREE' else plan_tier end as "planTier", plan_expires_at as "planExpiresAt",
  is_active as "isActive", is_platform_admin as "isPlatformAdmin",
  deletion_requested_at as "deletionRequestedAt", created_at as "createdAt"
`;

export async function getTenantById(sql: Sql, tenantId: string): Promise<Tenant | null> {
  const rows = await sql.unsafe<Tenant[]>(`select ${SELECT} from tenants where tenant_id = $1`, [tenantId]);
  return rows[0] ?? null;
}

export interface ProfileUpdate {
  businessName?: string;
  displayName?: string;
  phoneNumber?: string;
  countryCode?: string;
  gstinNumber?: string;
  gstRegistered?: boolean;
}

export async function updateTenantProfile(sql: Sql, tenantId: string, patch: ProfileUpdate): Promise<Tenant> {
  const rows = await sql.unsafe<Tenant[]>(
    `update tenants set
      business_name = coalesce($1, business_name),
      display_name = coalesce($2, display_name),
      phone_number = coalesce($3, phone_number),
      country_code = coalesce($4, country_code),
      gstin_number = coalesce($5, gstin_number),
      gst_registered = coalesce($6, gst_registered),
      updated_at = now()
    where tenant_id = $7
    returning ${SELECT}`,
    [
      patch.businessName ?? null, patch.displayName ?? null, patch.phoneNumber ?? null,
      patch.countryCode ?? null, patch.gstinNumber ?? null, patch.gstRegistered ?? null, tenantId,
    ],
  );
  return rows[0]!;
}

// --- Admin (internal/httpapi/admin_handlers.go) ---------------------------
export async function listAllTenants(sql: Sql, limit: number, offset: number): Promise<Tenant[]> {
  return sql.unsafe<Tenant[]>(
    `select ${SELECT} from tenants order by created_at desc limit $1 offset $2`,
    [limit, offset],
  );
}

export async function setTenantActive(sql: Sql, tenantId: string, isActive: boolean): Promise<void> {
  await sql`update tenants set is_active = ${isActive}, updated_at = now() where tenant_id = ${tenantId}`;
}

export async function countTenants(sql: Sql): Promise<number> {
  const rows = await sql<{ count: string }[]>`select count(*)::text from tenants`;
  return parseInt(rows[0]!.count, 10);
}

export async function getTenantByWhatsAppPhone(sql: Sql, phone: string): Promise<Tenant | null> {
  const rows = await sql.unsafe<Tenant[]>(`select ${SELECT} from tenants where whatsapp_binding_phone = $1`, [phone]);
  return rows[0] ?? null;
}

export async function getTenantByIngestEmailAlias(sql: Sql, alias: string): Promise<Tenant | null> {
  const rows = await sql.unsafe<Tenant[]>(`select ${SELECT} from tenants where ingest_email_alias = $1`, [alias]);
  return rows[0] ?? null;
}

// --- Self-service account deletion (src/routes/auth.ts, src/purge.ts) -----

// Deliberately does not touch is_active — see db/schema.sql's comment on
// this column for why the account stays fully usable during the grace
// period.
export async function requestTenantDeletion(sql: Sql, tenantId: string): Promise<void> {
  await sql`update tenants set deletion_requested_at = now(), updated_at = now() where tenant_id = ${tenantId}`;
}

export async function cancelTenantDeletion(sql: Sql, tenantId: string): Promise<void> {
  await sql`update tenants set deletion_requested_at = null, updated_at = now() where tenant_id = ${tenantId}`;
}

// Cross-tenant by design — called only from the cron purge sweep
// (src/purge.ts), which runs under system_context.
export async function listTenantsPendingPurge(sql: Sql, olderThan: Date, limit = 100): Promise<Tenant[]> {
  return sql.unsafe<Tenant[]>(
    `select ${SELECT} from tenants where deletion_requested_at is not null and deletion_requested_at <= $1 order by deletion_requested_at asc limit $2`,
    [olderThan.toISOString(), limit],
  );
}
