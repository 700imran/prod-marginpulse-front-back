// Turning a PAID Razorpay order into a plan upgrade — shared by the two ways we learn about a payment:
//   1. the browser calls POST /billing/verify-payment right after checkout (fast, but only if the customer's browser survives), and
//   2. Razorpay calls our webhook (order.paid / payment.captured) from its servers (the one that still fires when the customer
//      closed the tab, lost network, or was bounced through a UPI app on a phone and never came back to the page).
// Razorpay's own guidance: verify on the server and "rely on webhooks for all automation". Both paths run the same checks and the
// same idempotent write, so whichever arrives first applies the plan and the other is a harmless no-op.
import type { Env } from "../config";
import type { Sql } from "../db";
import { appendAuditLog } from "../repository/auditLog";
import { invalidateTenantCache } from "../auth/supabase";
import { PLANS, TIER_RANK, isPlanId, type PlanId } from "./plans";

export interface RazorpayOrder { id: string; status: string; amount: number; amount_paid?: number; currency: string; notes?: Record<string, string> }

export class RazorpayLookupError extends Error {}

/** Fetches the order from Razorpay (the source of truth). Throws RazorpayLookupError when Razorpay can't be reached or refuses. */
export async function fetchRazorpayOrder(env: Env, orderId: string, timeoutMs = 10_000): Promise<RazorpayOrder> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new RazorpayLookupError("Razorpay is not configured");
  try {
    const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const r = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new RazorpayLookupError(`Razorpay answered ${r.status}`);
    return (await r.json()) as RazorpayOrder;
  } catch (e) {
    if (e instanceof RazorpayLookupError) throw e;
    throw new RazorpayLookupError((e as Error).message);
  }
}

export type OrderCheck =
  | { ok: true; planId: PlanId; tenantId: string }
  | { ok: false; reason: "no_owner" | "not_paid"; orderStatus: string };

/** An order only counts when it names a tenant + a real plan (we put both in the notes when creating it) and was paid IN FULL. */
export function checkPaidOrder(order: RazorpayOrder): OrderCheck {
  const planId = order.notes?.plan, tenantId = order.notes?.tenantId;
  if (!tenantId || !isPlanId(planId)) return { ok: false, reason: "no_owner", orderStatus: order.status };
  if (order.status !== "paid" || order.currency !== "INR" || order.amount !== PLANS[planId].priceInr * 100 || (order.amount_paid ?? order.amount) !== order.amount) {
    return { ok: false, reason: "not_paid", orderStatus: order.status };
  }
  return { ok: true, planId, tenantId };
}

export interface PlanResult { status: "applied" | "kept_higher" | "duplicate" | "no_tenant"; planTier: string }

/**
 * Applies one paid order to one tenant, exactly once per payment id.
 * A per-payment advisory lock serialises the browser verification and the webhook, which normally arrive within a second of each
 * other; inside the lock the "already recorded?" check, the plan change and the audit entry commit together, so a crash can never
 * leave a payment recorded-but-not-applied. A higher existing tier is never downgraded (the payment is still recorded).
 */
export async function applyPaidPlan(sql: Sql, o: { tenantId: string; planId: PlanId; paymentId: string; orderId: string; source: "verify" | "webhook" }): Promise<PlanResult> {
  const result = await (sql as any).begin(async (tx: Sql) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"razorpay:" + o.paymentId}))`;
    const [tenant] = await tx<{ planTier: string; ownerEmail: string }[]>`select plan_tier as "planTier", owner_email as "ownerEmail" from tenants where tenant_id = ${o.tenantId} for update`;
    if (!tenant) return { status: "no_tenant", planTier: "" } as PlanResult;
    // strpos, not LIKE: Razorpay ids look like "pay_Abc123", and "_" is a LIKE wildcard. The previous check stripped the underscore
    // before matching, so it never matched the stored "pay_…" text and a re-verified payment was recorded again every time.
    const [seen] = await tx<{ n: string }[]>`select count(*)::text as n from audit_log where tenant_id = ${o.tenantId} and action = 'PLAN_UPGRADED' and strpos(reason, ${o.paymentId}) > 0`;
    if (parseInt(seen?.n ?? "0", 10) > 0) return { status: "duplicate", planTier: tenant.planTier } as PlanResult;

    const upgrade = (TIER_RANK[tenant.planTier] ?? 0) < PLANS[o.planId].rank;
    if (upgrade) await tx`update tenants set plan_tier = ${PLANS[o.planId].tier}, updated_at = now() where tenant_id = ${o.tenantId}`;
    await appendAuditLog(tx, {
      tenantId: o.tenantId, entityType: "TENANT", entityId: o.tenantId, action: "PLAN_UPGRADED", fieldName: "plan_tier",
      oldValue: tenant.planTier, newValue: upgrade ? PLANS[o.planId].tier : tenant.planTier,
      reason: `razorpay payment ${o.paymentId} order ${o.orderId}${upgrade ? "" : " (no downgrade applied)"}${o.source === "webhook" ? " [webhook]" : ""}`,
      actorEmail: tenant.ownerEmail,
    });
    return { status: upgrade ? "applied" : "kept_higher", planTier: upgrade ? PLANS[o.planId].tier : tenant.planTier } as PlanResult;
  }) as PlanResult;
  if (result.status === "applied") invalidateTenantCache(o.tenantId);
  return result;
}

/** True for the webhook events that mean "money arrived". Everything else Razorpay sends is only logged. */
export const isPaymentEvent = (name: unknown): boolean => name === "order.paid" || name === "payment.captured";

/**
 * Webhook side of a payment: finds the order, re-reads it from Razorpay (we never trust the webhook body for the amount or the
 * owner), then applies the plan. `retry: true` means "answer 5xx so Razorpay redelivers" (Razorpay unreachable or the database
 * failed) — every other outcome, including "not ours" and "not fully paid", is final.
 */
export async function processPaymentWebhook(env: Env, sql: Sql, event: any): Promise<{ retry: boolean; outcome: string }> {
  const pay = event?.payload?.payment?.entity, ord = event?.payload?.order?.entity;
  const paymentId = typeof pay?.id === "string" ? pay.id : "";
  const orderIdRaw = pay?.order_id ?? ord?.id;
  const orderId = typeof orderIdRaw === "string" ? orderIdRaw : "";
  if (!paymentId || !orderId) return { retry: false, outcome: "ignored_no_ids" };
  try {
    const order = await fetchRazorpayOrder(env, orderId);
    const check = checkPaidOrder(order);
    if (!check.ok) return { retry: false, outcome: check.reason === "no_owner" ? "ignored_not_ours" : "ignored_not_paid" };
    const r = await applyPaidPlan(sql, { tenantId: check.tenantId, planId: check.planId, paymentId, orderId: order.id, source: "webhook" });
    return { retry: false, outcome: r.status };
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "razorpay_webhook_failed", paymentId, orderId, error: (e as Error).message }));
    return { retry: true, outcome: "retry" };
  }
}

export interface RazorpayConfigCheck {
  ok: boolean;
  keyMode: "live" | "test" | "missing" | "unknown";
  keysAccepted: boolean | null; // null = could not ask Razorpay
  webhookSecretSet: boolean;
  problems: string[];
}

/**
 * One-call answer to "why aren't real payments completing?" from the live Worker's own configuration. Reports booleans and a mode only —
 * never a key or secret. Asks Razorpay to list one order, which succeeds only when the key id + secret pair is valid for that account.
 */
export async function checkRazorpayConfig(env: Env, timeoutMs = 8_000): Promise<RazorpayConfigCheck> {
  const problems: string[] = [];
  const id = env.RAZORPAY_KEY_ID ?? "", secret = env.RAZORPAY_KEY_SECRET ?? "";
  const keyMode = !id || !secret ? "missing" : id.startsWith("rzp_live_") ? "live" : id.startsWith("rzp_test_") ? "test" : "unknown";
  const webhookSecretSet = !!env.RAZORPAY_WEBHOOK_SECRET;
  let keysAccepted: boolean | null = null;

  if (keyMode === "missing") problems.push("RAZORPAY_KEY_ID and/or RAZORPAY_KEY_SECRET are not set on the Worker, so every create-order call fails with 500 \"Razorpay is not configured\".");
  else {
    if (keyMode === "test") problems.push("The Worker is using TEST keys (rzp_test_…): checkout works but no real money moves. Switch to the Live keys from Razorpay Dashboard → Account & Settings → API Keys (needs an activated account).");
    if (keyMode === "unknown") problems.push("RAZORPAY_KEY_ID does not start with rzp_live_ or rzp_test_ — it is probably pasted wrongly.");
    try {
      const r = await fetch("https://api.razorpay.com/v1/orders?count=1", { headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) keysAccepted = true;
      else {
        keysAccepted = r.status === 401 || r.status === 403 ? false : null;
        if (r.status === 401) problems.push("Razorpay rejected the key pair (401): the key id and secret do not belong together, or the secret was regenerated. Re-copy both from the dashboard.");
        else if (r.status === 403) problems.push("Razorpay refused the request (403): the account is probably not activated for this mode (KYC / live access pending).");
        else problems.push(`Razorpay answered ${r.status} when asked to list orders; try again, and check status.razorpay.com.`);
      }
    } catch (e) { problems.push(`Could not reach Razorpay from the Worker (${(e as Error).message}).`); }
  }
  if (!webhookSecretSet) problems.push("RAZORPAY_WEBHOOK_SECRET is not set: Razorpay's server-to-server webhook is rejected, so a customer whose browser closes before confirmation pays but never gets the plan. Set it to the secret entered when adding the webhook in the dashboard.");
  return { ok: problems.length === 0, keyMode, keysAccepted, webhookSecretSet, problems };
}
