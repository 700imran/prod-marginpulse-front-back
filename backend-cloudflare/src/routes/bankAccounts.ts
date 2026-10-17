import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { createBankAccount, listBankAccounts, getBankAccountById, setPrimaryBankAccount, deleteBankAccount, findByLast4AndIFSC } from "../repository/bankAccounts";
import { encryptField, last4 } from "../security/fieldEncryption";
import { reserveForOperation } from "../billing/guard";
import { apiError } from "../http";

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
    return apiError(c, 400, "VALIDATION_ERROR", "bank_name, account_holder_name, account_number, and ifsc_code are required");
  }
  if (!IFSC_PATTERN.test(ifscCode)) return apiError(c, 400, "VALIDATION_ERROR", "Invalid IFSC code format");

  const tenant = c.get("tenant");
  const tenantId = tenant.tenantId;
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

  // The account record itself is stored either way — only the paid
  // verification call is gated by credits. If credits are short, the
  // account just stays PENDING (its default) until /reverify-style credit
  // becomes available; there's no reverify endpoint for bank accounts yet,
  // so for now this only degrades gracefully for a low/empty wallet rather
  // than blocking account creation.
  const jobId = crypto.randomUUID();
  const reservation = await reserveForOperation(sql, tenant, "BANK_ACCOUNT_VERIFY", jobId);
  if (reservation.ok) {
    await c.env.BANK_ACCOUNT_QUEUE.send({
      task: "verify_bank_account_task", job_id: jobId, args: { tenant_id: tenantId, bank_account_id: item.bankAccountId },
      credit_reservation: { tenant_id: tenantId, operation: "BANK_ACCOUNT_VERIFY", amount: reservation.amount },
    });
  }

  const { accountNumberEncrypted: _drop, ...out } = item;
  return c.json({ ...out, credits_remaining: reservation.ok ? reservation.balanceAfter : undefined }, 201);
});

bankAccountRoutes.post("/:id/set-primary", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getBankAccountById(c.get("sql"), tenantId, id);
  if (!existing) return apiError(c, 404, "NOT_FOUND", "bank account not found");

  await setPrimaryBankAccount(c.get("sql"), tenantId, id);
  const updated = await getBankAccountById(c.get("sql"), tenantId, id);
  const { accountNumberEncrypted: _drop, ...out } = updated!;
  return c.json(out);
});

bankAccountRoutes.delete("/:id", async (c) => {
  const tenantId = c.get("tenant").tenantId;
  const id = c.req.param("id");
  const existing = await getBankAccountById(c.get("sql"), tenantId, id);
  if (!existing) return apiError(c, 404, "NOT_FOUND", "bank account not found");

  await deleteBankAccount(c.get("sql"), tenantId, id);
  return c.body(null, 204);
});
