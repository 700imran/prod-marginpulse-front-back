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
  isActive: boolean;
  isPlatformAdmin: boolean;
  createdAt: string;
}

const SELECT = `
  tenant_id as "tenantId", business_name as "businessName", display_name as "displayName",
  owner_email as "ownerEmail", phone_number as "phoneNumber", country_code as "countryCode",
  whatsapp_binding_phone as "whatsappBindingPhone", ingest_email_alias as "ingestEmailAlias",
  gstin_number as "gstinNumber", gst_registered as "gstRegistered", plan_tier as "planTier",
  is_active as "isActive", is_platform_admin as "isPlatformAdmin", created_at as "createdAt"
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
  const rows = await sql<Tenant[]>`
    update tenants set
      business_name = coalesce(${patch.businessName ?? null}, business_name),
      display_name = coalesce(${patch.displayName ?? null}, display_name),
      phone_number = coalesce(${patch.phoneNumber ?? null}, phone_number),
      country_code = coalesce(${patch.countryCode ?? null}, country_code),
      gstin_number = coalesce(${patch.gstinNumber ?? null}, gstin_number),
      gst_registered = coalesce(${patch.gstRegistered ?? null}, gst_registered),
      updated_at = now()
    where tenant_id = ${tenantId}
    returning
      tenant_id as "tenantId", business_name as "businessName", display_name as "displayName",
      owner_email as "ownerEmail", phone_number as "phoneNumber", country_code as "countryCode",
      whatsapp_binding_phone as "whatsappBindingPhone", ingest_email_alias as "ingestEmailAlias",
      gstin_number as "gstinNumber", gst_registered as "gstRegistered", plan_tier as "planTier",
      is_active as "isActive", is_platform_admin as "isPlatformAdmin", created_at as "createdAt"
  `;
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
