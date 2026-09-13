import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { createBankAccount, listBankAccounts, getBankAccountById, setPrimaryBankAccount, deleteBankAccount, findByLast4AndIFSC } from "../repository/bankAccounts";
import { encryptField, last4 } from "../security/fieldEncryption";

export const bankAccountRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

bankAccountRoutes.use("*", requireAuth);

const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

bankAccountRoutes.get("/", async (c) => {
  const items = await listBankAccounts(c.get("sql"), c.get("tenant").tenantId);
  // account_number_encrypted never leaves this layer — strip it before responding, matching bankAccountOut's shape.
  return c.json(items.map(({ accountNumberEncrypted, ...rest }) => rest));
});

bankAccountRoutes.post("/", async (c) => {
  const { bank_name: bankName, account_holder_name: accountHolderName, account_number: accountNumber, ifsc_code: ifscCode, account_type } = await c.req.json();
  if (!bankName || !accountHolderName || !accountNumber || !ifscCode) {
    return c.json({ error: "bank_name, account_holder_name, account_number, and ifsc_code are required" }, 400);
  }
  if (!IFSC_PATTERN.test(ifscCode)) return c.json({ error: "Invalid IFSC code format" }, 400);

  const tenantId = c.get("tenant").tenantId;
  const sql = c.get("sql");
  const accountLast4 = last4(accountNumber);

  // Warn-only duplicate check (doesn't block creation) — same as the Go handler.
  const existing = await findByLast4AndIFSC(sql, tenantId, accountLast4, ifscCode);
  if (existing) console.warn("possible duplicate bank account", { tenantId, existingId: existing.bankAccountId });

  const encrypted = await encryptField(c.env, accountNumber);
  const item = await createBankAccount(sql, {
    tenantId, bankName, accountHolderName, accountNumberEncrypted: encrypted, accountNumberLast4: accountLast4,
    ifscCode, accountType: account_type || "CURRENT",
  });

  await c.env.BANK_ACCOUNT_QUEUE.send({ task: "verify_bank_account_task", job_id: crypto.randomUUID(), args: { tenant_id: tenantId, bank_account_id: item.bankAccountId } });

  const { accountNumberEncrypted: _drop, ...out } = item;
  return c.json(out, 201);
});

bankAccountRoutes.post("/:id/set-primary", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getBankAccountById(c.get("sql"), tenantId, id);
  if (!existing) return c.json({ error: "bank account not found" }, 404);

  await setPrimaryBankAccount(c.get("sql"), tenantId, id);
  const updated = await getBankAccountById(c.get("sql"), tenantId, id);
  const { accountNumberEncrypted: _drop, ...out } = updated!;
  return c.json(out);
});

bankAccountRoutes.delete("/:id", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getBankAccountById(c.get("sql"), tenantId, id);
  if (!existing) return c.json({ error: "bank account not found" }, 404);

  await deleteBankAccount(c.get("sql"), tenantId, id);
  return c.body(null, 204);
});
