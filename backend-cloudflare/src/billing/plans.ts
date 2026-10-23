// Plans and which features each unlocks — the single source of truth, served to
// the frontend by GET /billing/plans so the two can never disagree.
//
// Naming: the database stores FREE / STARTER / GROWTH / ENTERPRISE; customers see
// Free / Starter / Pro / Enterprise — the names and prices on the Billing page
// (Starter ₹499, Pro ₹1499, Enterprise ₹4999). So the database's GROWTH tier is
// what customers call "Pro". Change a label here and it changes everywhere (the
// sidebar badges and the pricing page are both driven by GET /billing/plans).
import type { Env } from "../config";
import { monthlyAllowanceForPlan } from "./pricing";

export const PLAN_ORDER = ["FREE", "STARTER", "GROWTH", "ENTERPRISE"] as const;
export type PlanTier = (typeof PLAN_ORDER)[number];
export type PaidPlan = Exclude<PlanTier, "FREE">;

export const PLAN_LABELS: Record<PlanTier, string> = { FREE: "Free", STARTER: "Starter", GROWTH: "Pro", ENTERPRISE: "Enterprise" };

export const FEATURES = {
  gst_sync: { label: "Tax Portal Sync", minPlan: "STARTER" },
  recon_rules: { label: "Reconciliation Rules", minPlan: "STARTER" },
  audit_log: { label: "Audit Trail", minPlan: "STARTER" },
  integrations: { label: "API & Integrations", minPlan: "GROWTH" },
  notifications: { label: "Notifications", minPlan: "GROWTH" },
  team: { label: "Audit Team", minPlan: "GROWTH" },
} as const satisfies Record<string, { label: string; minPlan: PlanTier }>;
export type FeatureKey = keyof typeof FEATURES;

export function isPlanTier(v: unknown): v is PlanTier {
  return typeof v === "string" && (PLAN_ORDER as readonly string[]).includes(v);
}
export function isPaidPlan(v: unknown): v is PaidPlan {
  return isPlanTier(v) && v !== "FREE";
}
export const planRank = (p: string): number => Math.max(0, PLAN_ORDER.indexOf(p as PlanTier)); // unknown → treated as FREE

export function planAllows(plan: string, feature: FeatureKey): boolean {
  return planRank(plan) >= planRank(FEATURES[feature].minPlan);
}

/** Feature enforcement is OFF unless explicitly switched on — see ENFORCE_PLAN_GATING in wrangler.toml. */
export function gatingEnforced(env: Pick<Env, "ENFORCE_PLAN_GATING">): boolean {
  return env.ENFORCE_PLAN_GATING === "true";
}

/**
 * Prices come from config, never from the client and never hard-coded:
 * PLAN_PRICES_INR='{"STARTER":999,"GROWTH":2499,"ENTERPRISE":4999}' (whole rupees per month).
 * Anything missing, non-integer, or non-positive is treated as "not for sale yet".
 */
export function planPricesInr(env: Pick<Env, "PLAN_PRICES_INR">): Partial<Record<PaidPlan, number>> {
  let parsed: unknown;
  try { parsed = JSON.parse(env.PLAN_PRICES_INR ?? "{}"); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Partial<Record<PaidPlan, number>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isPaidPlan(k) && typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 10_000_000) out[k] = v;
  }
  return out;
}

export function paymentsConfigured(env: Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET" | "RAZORPAY_WEBHOOK_SECRET">): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET);
}

export interface PlanCatalogEntry {
  id: PlanTier; label: string; monthlyCredits: number;
  priceInr: number | null; purchasable: boolean; features: FeatureKey[];
}
export function planCatalog(env: Pick<Env, "PLAN_PRICES_INR" | "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET" | "RAZORPAY_WEBHOOK_SECRET">): PlanCatalogEntry[] {
  const prices = planPricesInr(env);
  const live = paymentsConfigured(env);
  return PLAN_ORDER.map((id) => ({
    id, label: PLAN_LABELS[id], monthlyCredits: monthlyAllowanceForPlan(id),
    priceInr: id === "FREE" ? 0 : prices[id as PaidPlan] ?? null,
    purchasable: id !== "FREE" && live && prices[id as PaidPlan] !== undefined,
    features: (Object.keys(FEATURES) as FeatureKey[]).filter((f) => planAllows(id, f)),
  }));
}
