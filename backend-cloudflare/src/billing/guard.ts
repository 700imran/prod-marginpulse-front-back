// Thin convenience wrapper so route handlers stay short: grants this
// month's plan allowance if it hasn't happened yet, looks up the
// operation's cost, and reserves it. Routes call this right before
// enqueueing (or doing) the expensive work and check `.ok` before
// proceeding — see routes/gst.ts, routes/taxIdentifiers.ts,
// routes/bankAccounts.ts for the call sites.
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { ensureMonthlyGrant, reserveCredits, type ReserveResult } from "./credits";
import { recordUsageEvent } from "./usage";
import { operationCost } from "./pricing";

export async function reserveForOperation(
  sql: Sql,
  tenant: TenantContext,
  operation: string,
  jobId: string,
  correlationId?: string,
): Promise<ReserveResult & { amount: number }> {
  await ensureMonthlyGrant(sql, tenant.tenantId, tenant.planTier);
  const amount = operationCost(operation);
  const result = await reserveCredits(sql, { tenantId: tenant.tenantId, amount, operation, jobId, correlationId });
  if (!result.ok) {
    await recordUsageEvent(sql, {
      tenantId: tenant.tenantId, provider: operation, operation, outcome: "FAILED",
      creditsConsumed: 0, correlationId: correlationId ?? jobId, jobId,
    });
  }
  return { ...result, amount };
}
