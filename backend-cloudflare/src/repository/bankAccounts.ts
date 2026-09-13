import type { Sql } from "../db";

export interface BankAccountRow {
  bankAccountId: string;
  tenantId: string;
  bankName: string;
  accountHolderName: string;
  accountNumberEncrypted: string;
  accountNumberLast4: string;
  ifscCode: string;
  accountType: string;
  verificationStatus: string;
  verifiedAt: string | null;
  verificationError: string | null;
  isPrimary: boolean;
  createdAt: string;
}

const SELECT = `
  bank_account_id as "bankAccountId", tenant_id as "tenantId", bank_name as "bankName",
  account_holder_name as "accountHolderName", account_number_encrypted as "accountNumberEncrypted",
  account_number_last4 as "accountNumberLast4", ifsc_code as "ifscCode", account_type as "accountType",
  verification_status as "verificationStatus", verified_at as "verifiedAt", verification_error as "verificationError",
  is_primary as "isPrimary", created_at as "createdAt"
`;

export async function createBankAccount(
  sql: Sql,
  input: { tenantId: string; bankName: string; accountHolderName: string; accountNumberEncrypted: string; accountNumberLast4: string; ifscCode: string; accountType: string },
): Promise<BankAccountRow> {
  const rows = await sql.unsafe<BankAccountRow[]>(
    `insert into bank_accounts (tenant_id, bank_name, account_holder_name, account_number_encrypted, account_number_last4, ifsc_code, account_type)
     values ($1,$2,$3,$4,$5,$6,$7) returning ${SELECT}`,
    [input.tenantId, input.bankName, input.accountHolderName, input.accountNumberEncrypted, input.accountNumberLast4, input.ifscCode, input.accountType],
  );
  return rows[0]!;
}

export async function listBankAccounts(sql: Sql, tenantId: string): Promise<BankAccountRow[]> {
  return sql.unsafe<BankAccountRow[]>(`select ${SELECT} from bank_accounts where tenant_id = $1 order by is_primary desc, created_at asc`, [tenantId]);
}

export async function getBankAccountById(sql: Sql, tenantId: string, id: string): Promise<BankAccountRow | null> {
  const rows = await sql.unsafe<BankAccountRow[]>(`select ${SELECT} from bank_accounts where tenant_id = $1 and bank_account_id = $2`, [tenantId, id]);
  return rows[0] ?? null;
}

export async function updateBankAccountVerification(sql: Sql, id: string, status: string, verifiedName: string | null, error: string | null): Promise<void> {
  await sql`
    update bank_accounts set verification_status = ${status}, verified_at = now(),
      verified_account_holder_name = ${verifiedName}, verification_error = ${error}, updated_at = now()
    where bank_account_id = ${id}
  `;
}

export async function setPrimaryBankAccount(sql: Sql, tenantId: string, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`update bank_accounts set is_primary = false where tenant_id = ${tenantId}`;
    await tx`update bank_accounts set is_primary = true, updated_at = now() where tenant_id = ${tenantId} and bank_account_id = ${id}`;
  });
}

export async function deleteBankAccount(sql: Sql, tenantId: string, id: string): Promise<void> {
  await sql`delete from bank_accounts where tenant_id = ${tenantId} and bank_account_id = ${id}`;
}

export async function findByLast4AndIFSC(sql: Sql, tenantId: string, last4: string, ifscCode: string): Promise<BankAccountRow | null> {
  const rows = await sql.unsafe<BankAccountRow[]>(
    `select ${SELECT} from bank_accounts where tenant_id = $1 and account_number_last4 = $2 and ifsc_code = $3 limit 1`,
    [tenantId, last4, ifscCode],
  );
  return rows[0] ?? null;
}
