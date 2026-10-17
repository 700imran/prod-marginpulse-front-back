// Central place for usage-credit economics. This is deliberately the ONLY
// file with numbers in it — every reserve/refund call site below imports
// from here rather than hardcoding a cost, so tuning pricing is a one-file
// change, not a grep-and-replace across routes and pipelines.
//
// IMPORTANT: every figure below is a placeholder guess, not a costing
// exercise against real vendor invoices. Replace both maps with real
// numbers once you have actual GST-API / bank-verification-API / Anthropic
// costs and a real subscription price list — nothing else in src/billing/
// needs to change when you do.

// Monthly credit allowance granted to a tenant's wallet at the start of
// each billing period, keyed by tenants.plan_tier (see db/schema.sql).
// This is the "subscription" side of the split the spec asked for: what a
// plan includes before any pay-as-you-go top-up or overage.
export const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  FREE: 10,
  STARTER: 150,
  GROWTH: 750,
  ENTERPRISE: 3000,
};

// Credits charged per call to a metered operation. Keep this in sync with
// every reserveCredits()/refundCredits() call site — grep for
// OPERATION_COST_CREDITS if you add a new metered operation.
export const OPERATION_COST_CREDITS: Record<string, number> = {
  GST_SYNC: 5, // one GSTR-2B fetch + cross-verify sweep for the whole tenant
  TAX_IDENTIFIER_VERIFY: 1, // one GSTIN/PAN lookup
  BANK_ACCOUNT_VERIFY: 1, // one bank-account verification call
  AI_INSIGHT: 1, // one Anthropic dashboard-summary call (degrades to free rule-based insight instead of blocking)
};

export function operationCost(operation: string): number {
  const cost = OPERATION_COST_CREDITS[operation];
  if (cost === undefined) {
    throw new Error(`no configured credit cost for operation "${operation}" — add it to OPERATION_COST_CREDITS in src/billing/pricing.ts`);
  }
  return cost;
}

export function monthlyAllowanceForPlan(planTier: string): number {
  return PLAN_MONTHLY_CREDITS[planTier] ?? PLAN_MONTHLY_CREDITS.FREE!;
}
