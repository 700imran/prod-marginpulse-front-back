// Prices live on the SERVER. The client only says which plan it wants — it can
// never choose the amount (previously POST {amount: 1} bought any plan for Rs 1).
// Keep in sync with PLAN_OPTIONS in frontend BillingView.jsx (display only).
export const PLANS = {
  starter: { tier: "STARTER", priceInr: 499, rank: 1 },
  pro: { tier: "GROWTH", priceInr: 1499, rank: 2 },
  enterprise: { tier: "ENTERPRISE", priceInr: 4999, rank: 3 },
} as const;
export type PlanId = keyof typeof PLANS;
export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && Object.prototype.hasOwnProperty.call(PLANS, v);
export const TIER_RANK: Record<string, number> = { FREE: 0, STARTER: 1, GROWTH: 2, ENTERPRISE: 3 };

