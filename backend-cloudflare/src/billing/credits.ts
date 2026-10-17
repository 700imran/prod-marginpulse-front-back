// Usage-credit wallet + ledger — the money-correctness core of the
// usage-based billing layer. Every function here either does nothing or
// does exactly one atomic, idempotent thing to a tenant's balance.
//
// Design, so the next person touching this doesn't have to reverse it
// out of the SQL:
//
// - credit_wallets.balance_credits is the single source of truth for
//   "how many credits does this tenant have right now."
// - credit_ledger is append-only and immutable — inserted into, never
//   updated or deleted. It's the audit trail for every balance change.
// - Every ledger insert carries a unique (tenant_id, idempotency_key).
//   A caller that retries an operation (a re-sent HTTP request, a
//   redelivered queue message after a Worker restart) passes the *same*
//   idempotency_key, so the unique constraint turns the retry into a safe
//   no-op instead of a double charge or double refund. This is what the
//   "prevent duplicate deductions / replay / concurrent double-spending"
//   requirement actually comes down to at the SQL level.
// - The balance update and the matching ledger insert always happen in
//   one Postgres transaction (sql.begin()) — either both land or neither
//   does. If the ledger insert fails (most commonly: duplicate key), the
//   transaction rolls back and the balance change is undone with it.
// - The balance update itself is one `UPDATE ... WHERE balance >= amount
//   OR overage_allowed RETURNING ...` statement. That single atomic
//   statement is what actually prevents concurrent double-spending —
//   Postgres serializes concurrent UPDATEs to the same row, so two
//   simultaneous requests against a tenant with only enough balance for
//   one of them can never both succeed. There is deliberately no
//   separate "check balance, then update" step; that gap is exactly the
//   race condition this design avoids.
import type { Sql } from "../db";
import { monthlyAllowanceForPlan } from "./pricing";

export interface ReserveResult {
  ok: boolean;
  balanceAfter: number;
  alreadyProcessed?: boolean;
  reason?: "INSUFFICIENT_CREDITS";
}

export interface CreditWalletSummary {
  tenantId: string;
  balanceCredits: number;
  overageAllowed: boolean;
  monthlyAllowanceCredits: number;
  currentPeriodStart: string;
}

function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

// Ensures a wallet row exists. Cheap no-op when it already does (true for
// every pre-existing tenant after the schema.sql backfill runs) — only
// matters for tenants created after that migration.
export async function ensureWallet(sql: Sql, tenantId: string): Promise<void> {
  await sql`insert into credit_wallets (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`;
}

// Grants the plan's monthly allowance once per calendar month per tenant.
// Idempotent via idempotency_key = 'monthly_grant:<tenantId>:<YYYY-MM>', so
// it's safe to call this on every authenticated request (cheap: one
// indexed read in the common case where this month's grant already
// happened) — it only writes on the first call of a new month.
export async function ensureMonthlyGrant(sql: Sql, tenantId: string, planTier: string): Promise<void> {
  await ensureWallet(sql, tenantId);
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  const [wallet] = await sql<{ currentPeriodStart: string }[]>`
    select current_period_start as "currentPeriodStart" from credit_wallets where tenant_id = ${tenantId}
  `;
  if (wallet && wallet.currentPeriodStart.slice(0, 7) === period) return; // already granted this month

  const allowance = monthlyAllowanceForPlan(planTier);
  const idempotencyKey = `monthly_grant:${tenantId}:${period}`;
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx<{ balanceCredits: string }[]>`
        update credit_wallets
        set balance_credits = balance_credits + ${allowance},
            monthly_allowance_credits = ${allowance},
            current_period_start = date_trunc('month', now())::date,
            updated_at = now()
        where tenant_id = ${tenantId}
        returning balance_credits as "balanceCredits"
      `;
      if (!row) return;
      await tx`
        insert into credit_ledger (tenant_id, entry_type, amount_credits, balance_after, operation, idempotency_key, description)
        values (${tenantId}, 'MONTHLY_GRANT', ${allowance}, ${row.balanceCredits}, 'MONTHLY_GRANT', ${idempotencyKey}, ${`Monthly grant for plan ${planTier}, period ${period}`})
      `;
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) return; // a concurrent request already granted this month
    throw e;
  }
}

export interface ReserveOptions {
  tenantId: string;
  amount: number;
  operation: string;
  jobId: string; // the idempotency anchor — pass the same job_id you enqueue/act with
  correlationId?: string;
  description?: string;
}

// Atomically deducts `amount` credits, or returns ok:false with
// reason:"INSUFFICIENT_CREDITS" if the tenant can't cover it and overage
// isn't allowed. Call this synchronously, before doing (or enqueuing) the
// expensive external work it pays for — never after, and if the work
// turns out not to happen, always follow up with refundCredits for the
// same jobId.
export async function reserveCredits(sql: Sql, opts: ReserveOptions): Promise<ReserveResult> {
  await ensureWallet(sql, opts.tenantId);
  const idempotencyKey = `reserve:${opts.jobId}`;
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx<{ balanceCredits: string }[]>`
        update credit_wallets
        set balance_credits = balance_credits - ${opts.amount}, updated_at = now()
        where tenant_id = ${opts.tenantId}
          and (overage_allowed or balance_credits >= ${opts.amount})
        returning balance_credits as "balanceCredits"
      `;
      if (rows.length === 0) {
        const [current] = await tx<{ balanceCredits: string }[]>`
          select balance_credits as "balanceCredits" from credit_wallets where tenant_id = ${opts.tenantId}
        `;
        return { ok: false, reason: "INSUFFICIENT_CREDITS" as const, balanceAfter: current ? parseFloat(current.balanceCredits) : 0 };
      }
      const balanceAfter = parseFloat(rows[0]!.balanceCredits);
      await tx`
        insert into credit_ledger (tenant_id, entry_type, amount_credits, balance_after, operation, reference_type, reference_id, idempotency_key, correlation_id, description)
        values (${opts.tenantId}, 'RESERVE', ${-opts.amount}, ${balanceAfter}, ${opts.operation}, 'job', ${opts.jobId}, ${idempotencyKey}, ${opts.correlationId ?? opts.jobId}, ${opts.description ?? `Reserved for ${opts.operation}`})
      `;
      return { ok: true, balanceAfter };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      // This exact jobId was already reserved (a retried request). The
      // transaction above — including the balance decrement — was rolled
      // back automatically, so the wallet is untouched by this call.
      // Return what the original reservation did instead of charging again.
      const [existing] = await sql<{ balanceAfter: string }[]>`
        select balance_after as "balanceAfter" from credit_ledger where tenant_id = ${opts.tenantId} and idempotency_key = ${idempotencyKey}
      `;
      return { ok: true, balanceAfter: existing ? parseFloat(existing.balanceAfter) : 0, alreadyProcessed: true };
    }
    throw e;
  }
}

export interface RefundOptions {
  tenantId: string;
  amount: number;
  operation: string;
  jobId: string;
  correlationId?: string;
  description?: string;
}

// Compensating transaction for a job that was charged (via reserveCredits)
// but never delivered the work it charged for — e.g. it exhausted its
// queue retries and landed in a dead-letter queue. Idempotent the same
// way reserveCredits is: safe to call more than once for the same jobId,
// only the first call has any effect.
export async function refundCredits(sql: Sql, opts: RefundOptions): Promise<ReserveResult> {
  await ensureWallet(sql, opts.tenantId);
  const idempotencyKey = `refund:${opts.jobId}`;
  try {
    return await sql.begin(async (tx) => {
      const [row] = await tx<{ balanceCredits: string }[]>`
        update credit_wallets
        set balance_credits = balance_credits + ${opts.amount}, updated_at = now()
        where tenant_id = ${opts.tenantId}
        returning balance_credits as "balanceCredits"
      `;
      const balanceAfter = parseFloat(row!.balanceCredits);
      await tx`
        insert into credit_ledger (tenant_id, entry_type, amount_credits, balance_after, operation, reference_type, reference_id, idempotency_key, correlation_id, description)
        values (${opts.tenantId}, 'REFUND', ${opts.amount}, ${balanceAfter}, ${opts.operation}, 'job', ${opts.jobId}, ${idempotencyKey}, ${opts.correlationId ?? opts.jobId}, ${opts.description ?? `Refund for failed ${opts.operation}`})
      `;
      return { ok: true, balanceAfter };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const [existing] = await sql<{ balanceAfter: string }[]>`
        select balance_after as "balanceAfter" from credit_ledger where tenant_id = ${opts.tenantId} and idempotency_key = ${idempotencyKey}
      `;
      return { ok: true, balanceAfter: existing ? parseFloat(existing.balanceAfter) : 0, alreadyProcessed: true };
    }
    throw e;
  }
}

// --- Read-only helpers for the self-service /billing endpoint --------------

export async function getWalletSummary(sql: Sql, tenantId: string): Promise<CreditWalletSummary> {
  await ensureWallet(sql, tenantId);
  const [row] = await sql<{ tenantId: string; balanceCredits: string; overageAllowed: boolean; monthlyAllowanceCredits: string; currentPeriodStart: string }[]>`
    select
      tenant_id as "tenantId", balance_credits as "balanceCredits", overage_allowed as "overageAllowed",
      monthly_allowance_credits as "monthlyAllowanceCredits", current_period_start as "currentPeriodStart"
    from credit_wallets where tenant_id = ${tenantId}
  `;
  return {
    tenantId: row!.tenantId,
    balanceCredits: parseFloat(row!.balanceCredits),
    overageAllowed: row!.overageAllowed,
    monthlyAllowanceCredits: parseFloat(row!.monthlyAllowanceCredits),
    currentPeriodStart: row!.currentPeriodStart,
  };
}

export interface LedgerEntry {
  ledgerId: string;
  entryType: string;
  amountCredits: number;
  balanceAfter: number;
  operation: string;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
}

export async function listLedger(sql: Sql, tenantId: string, limit = 50): Promise<LedgerEntry[]> {
  const rows = await sql<{ ledgerId: string; entryType: string; amountCredits: string; balanceAfter: string; operation: string; referenceId: string | null; description: string | null; createdAt: string }[]>`
    select ledger_id as "ledgerId", entry_type as "entryType", amount_credits as "amountCredits", balance_after as "balanceAfter",
           operation, reference_id as "referenceId", description, created_at as "createdAt"
    from credit_ledger where tenant_id = ${tenantId} order by created_at desc limit ${limit}
  `;
  return rows.map((r) => ({ ...r, amountCredits: parseFloat(r.amountCredits), balanceAfter: parseFloat(r.balanceAfter) }));
}
