import type { Sql } from "../db";

export interface TaxIdentifierRow {
  taxIdentifierId: string;
  tenantId: string;
  idType: string;
  idValue: string;
  label: string | null;
  verificationStatus: string;
  verifiedAt: string | null;
  verificationError: string | null;
  verifiedLegalName: string | null;
  isPrimary: boolean;
  createdAt: string;
}

const SELECT = `
  tax_identifier_id as "taxIdentifierId", tenant_id as "tenantId", id_type as "idType", id_value as "idValue",
  label, verification_status as "verificationStatus", verified_at as "verifiedAt",
  verification_error as "verificationError", verified_legal_name as "verifiedLegalName",
  is_primary as "isPrimary", created_at as "createdAt"
`;

export async function createTaxIdentifier(sql: Sql, tenantId: string, idType: string, idValue: string, label: string | null): Promise<TaxIdentifierRow> {
  const rows = await sql.unsafe<TaxIdentifierRow[]>(
    `insert into tax_identifiers (tenant_id, id_type, id_value, label) values ($1,$2,$3,$4) returning ${SELECT}`,
    [tenantId, idType, idValue, label],
  );
  return rows[0]!;
}

export async function listTaxIdentifiers(sql: Sql, tenantId: string): Promise<TaxIdentifierRow[]> {
  return sql.unsafe<TaxIdentifierRow[]>(`select ${SELECT} from tax_identifiers where tenant_id = $1 order by is_primary desc, created_at asc`, [tenantId]);
}

export async function getTaxIdentifierById(sql: Sql, tenantId: string, id: string): Promise<TaxIdentifierRow | null> {
  const rows = await sql.unsafe<TaxIdentifierRow[]>(`select ${SELECT} from tax_identifiers where tenant_id = $1 and tax_identifier_id = $2`, [tenantId, id]);
  return rows[0] ?? null;
}

export async function updateTaxIdentifierVerification(
  sql: Sql, id: string, status: string, legalName: string | null, error: string | null, metadata: unknown,
): Promise<void> {
  await sql`
    update tax_identifiers set
      verification_status = ${status}, verified_at = now(), verified_legal_name = ${legalName},
      verification_error = ${error}, verified_metadata = ${sql.json((metadata ?? {}) as any)}, updated_at = now()
    where tax_identifier_id = ${id}
  `;
}

// Clears is_primary on every other row of the same id_type, then sets it
// on the target — a real transaction, unlike the equivalent Dynamo dance.
export async function setPrimaryTaxIdentifier(sql: Sql, tenantId: string, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [target] = await tx<{ idType: string }[]>`select id_type as "idType" from tax_identifiers where tenant_id = ${tenantId} and tax_identifier_id = ${id}`;
    if (!target) throw new Error("tax identifier not found");
    await tx`update tax_identifiers set is_primary = false where tenant_id = ${tenantId} and id_type = ${target.idType}`;
    await tx`update tax_identifiers set is_primary = true, updated_at = now() where tenant_id = ${tenantId} and tax_identifier_id = ${id}`;
  });
}

export async function deleteTaxIdentifier(sql: Sql, tenantId: string, id: string): Promise<void> {
  await sql`delete from tax_identifiers where tenant_id = ${tenantId} and tax_identifier_id = ${id}`;
}
