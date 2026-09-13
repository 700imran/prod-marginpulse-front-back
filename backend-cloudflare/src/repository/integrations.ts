import type { Sql } from "../db";

export interface IntegrationRow {
  tenantId: string;
  provider: string;
  status: string;
  apiKeyEncrypted: string | null;
  credentialsEncrypted: string | null;
  accessTokenEncrypted: string | null;
  externalAccountId: string | null;
  externalAccountName: string | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
}

const SELECT = `
  tenant_id as "tenantId", provider, status, api_key_encrypted as "apiKeyEncrypted",
  credentials_encrypted as "credentialsEncrypted",
  access_token_encrypted as "accessTokenEncrypted", external_account_id as "externalAccountId",
  external_account_name as "externalAccountName", last_error as "lastError",
  connected_at as "connectedAt", last_synced_at as "lastSyncedAt"
`;

export async function listIntegrations(sql: Sql, tenantId: string): Promise<IntegrationRow[]> {
  return sql.unsafe<IntegrationRow[]>(`select ${SELECT} from integrations where tenant_id = $1`, [tenantId]);
}

export async function getIntegration(sql: Sql, tenantId: string, provider: string): Promise<IntegrationRow | null> {
  const rows = await sql.unsafe<IntegrationRow[]>(`select ${SELECT} from integrations where tenant_id = $1 and provider = $2`, [tenantId, provider]);
  return rows[0] ?? null;
}

export async function upsertIntegration(
  sql: Sql,
  input: { tenantId: string; provider: string; status: string; apiKeyEncrypted?: string; credentialsEncrypted?: string; accessTokenEncrypted?: string; externalAccountId?: string; externalAccountName?: string; lastError?: string },
): Promise<void> {
  await sql`
    insert into integrations (tenant_id, provider, status, api_key_encrypted, credentials_encrypted, access_token_encrypted, external_account_id, external_account_name, last_error, connected_at)
    values (${input.tenantId}, ${input.provider}, ${input.status}, ${input.apiKeyEncrypted ?? null}, ${input.credentialsEncrypted ?? null}, ${input.accessTokenEncrypted ?? null}, ${input.externalAccountId ?? null}, ${input.externalAccountName ?? null}, ${input.lastError ?? null}, now())
    on conflict (tenant_id, provider) do update set
      status = excluded.status, api_key_encrypted = excluded.api_key_encrypted, credentials_encrypted = excluded.credentials_encrypted,
      access_token_encrypted = excluded.access_token_encrypted,
      external_account_id = excluded.external_account_id, external_account_name = excluded.external_account_name,
      last_error = excluded.last_error, connected_at = now()
  `;
}

export async function markIntegrationSynced(sql: Sql, tenantId: string, provider: string): Promise<void> {
  await sql`update integrations set last_synced_at = now() where tenant_id = ${tenantId} and provider = ${provider}`;
}

export async function disconnectIntegration(sql: Sql, tenantId: string, provider: string): Promise<void> {
  await sql`update integrations set status = 'DISCONNECTED', access_token_encrypted = null where tenant_id = ${tenantId} and provider = ${provider}`;
}
