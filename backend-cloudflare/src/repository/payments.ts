import type { Sql } from "../db";
import { ensureWallet } from "../billing/credits";
import { monthlyAllowanceForPlan } from "../billing/pricing";
import { planRank, type PaidPlan } from "../billing/plans";

export async function insertPaymentOrder(
  sql: Sql, o: { tenantId: string; plan: PaidPlan; months: number; amountPaise: number; razorpayOrderId: string },
): Promise<void> {
  await sql`
    insert into payment_orders (tenant_id, plan, months, amount_paise, razorpay_order_id)
    values (${o.tenantId}, ${o.plan}, ${o.months}, ${o.amountPaise}, ${o.razorpayOrderId})
  `;
}

export type ActivationResult =
  | { status: "ACTIVATED"; tenantId: string; plan: PaidPlan; expiresAt: string; creditsGranted: number }
  | { status: "ALREADY_PAID" | "UNKNOWN_ORDER" | "AMOUNT_MISMATCH" | "WRONG_TENANT" };

/**
 * Turn a confirmed payment into an active plan — exactly once, however many times
 * and from however many places (browser confirmation, webhook, webhook retry) it
 * is called. The order row is locked (FOR UPDATE), so two concurrent calls
 * serialise and the second sees PAID. Nothing is granted unless:
 *   - the order exists (and, when `expectTenantId` is given, belongs to that tenant),
 *   - the provider-reported amount and currency equal what OUR server stored when
 *     it created the order (`amountPaise: null` = the caller has already confirmed
 *     the amount with the provider directly).
 * Effects, in one transaction: order -> PAID; tenant plan + expiry (a renewal of
 * the same plan extends from the current expiry, otherwise 30 days per month
 * from now); and the plan's extra monthly credits for the current period.
 */
export async function activatePaidOrder(
  sql: Sql,
  a: { razorpayOrderId: string; paymentId: string; amountPaise: number | null; currency: string; expectTenantId?: string },
): Promise<ActivationResult> {
  // Wallet must exist before the transaction (ensureWallet manages its own writes).
  const [peek] = await sql<{ tenantId: string }[]>`select tenant_id as "tenantId" from payment_orders where razorpay_order_id = ${a.razorpayOrderId}`;
  if (!peek) return { status: "UNKNOWN_ORDER" };
  await ensureWallet(sql, peek.tenantId);

  return sql.begin(async (tx): Promise<ActivationResult> => {
    const [order] = await tx<{ orderId: string; tenantId: string; plan: PaidPlan; months: number; amountPaise: string; currency: string; status: string }[]>`
      select order_id as "orderId", tenant_id as "tenantId", plan, months, amount_paise as "amountPaise", currency, status
      from payment_orders where razorpay_order_id = ${a.razorpayOrderId} for update
    `;
    if (!order) return { status: "UNKNOWN_ORDER" };
    if (a.expectTenantId && order.tenantId !== a.expectTenantId) return { status: "WRONG_TENANT" };
    if (order.status === "PAID") return { status: "ALREADY_PAID" };
    if (a.amountPaise !== null && (Number(order.amountPaise) !== a.amountPaise || order.currency !== a.currency)) return { status: "AMOUNT_MISMATCH" };

    await tx`update payment_orders set status = 'PAID', razorpay_payment_id = ${a.paymentId}, paid_at = now() where order_id = ${order.orderId}`;

    const [t] = await tx<{ prevPlan: string; renewing: boolean }[]>`
      select case when plan_expires_at is not null and plan_expires_at <= now() then 'FREE' else plan_tier end as "prevPlan",
             (plan_tier = ${order.plan} and plan_expires_at is not null and plan_expires_at > now()) as renewing
      from tenants where tenant_id = ${order.tenantId} for update
    `;
    const [updated] = await tx<{ expiresAt: string }[]>`
      update tenants
      set plan_tier = ${order.plan},
          plan_expires_at = (case when ${t!.renewing} then plan_expires_at else now() end) + (${order.months} * interval '30 days'),
          updated_at = now()
      where tenant_id = ${order.tenantId}
      returning plan_expires_at as "expiresAt"
    `;

    // Top up this period's credits to the new plan's allowance (never negative, never twice: the order is PAID now).
    const delta = Math.max(0, monthlyAllowanceForPlan(order.plan) - monthlyAllowanceForPlan(t!.prevPlan));
    if (delta > 0) {
      const [w] = await tx<{ balanceCredits: string }[]>`
        update credit_wallets
        set balance_credits = balance_credits + ${delta}, monthly_allowance_credits = ${monthlyAllowanceForPlan(order.plan)}, updated_at = now()
        where tenant_id = ${order.tenantId}
        returning balance_credits as "balanceCredits"
      `;
      if (w) {
        await tx`
          insert into credit_ledger (tenant_id, entry_type, amount_credits, balance_after, operation, reference_type, reference_id, idempotency_key, description)
          values (${order.tenantId}, 'PURCHASE', ${delta}, ${w.balanceCredits}, 'PLAN_PURCHASE', 'payment_order', ${order.orderId},
                  ${`plan_purchase:${order.orderId}`}, ${`Plan ${order.plan} purchased (${order.months} month${order.months > 1 ? "s" : ""})`})
        `;
      }
    }
    return { status: "ACTIVATED", tenantId: order.tenantId, plan: order.plan, expiresAt: updated!.expiresAt, creditsGranted: delta };
  }) as Promise<ActivationResult>;
}

/** The plan a tenant currently holds, as the app sees it (expired → FREE) — used to refuse buying a lower plan than one still active. */
export async function currentPlanOf(sql: Sql, tenantId: string): Promise<string> {
  const [t] = await sql<{ plan: string }[]>`
    select case when plan_expires_at is not null and plan_expires_at <= now() then 'FREE' else plan_tier end as plan from tenants where tenant_id = ${tenantId}
  `;
  return t?.plan ?? "FREE";
}
export { planRank };
