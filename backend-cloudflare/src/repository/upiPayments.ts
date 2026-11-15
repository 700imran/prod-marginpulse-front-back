import type { Sql } from "../db";
import { PLANS, TIER_RANK, type PlanId } from "../billing/plans";

export type UpiStatus = "PENDING" | "SUBMITTED" | "PAID" | "REJECTED" | "EXPIRED";
export interface UpiPayment {
  paymentId: string; tenantId: string; plan: PlanId; amountInr: number; reference: string; mode: "manual" | "gateway";
  gatewayOrderId: string | null; utr: string | null; status: UpiStatus; createdAt: string; expiresAt: string; submittedAt: string | null; decidedAt: string | null; decidedBy: string | null;
}
// Column lists are sql fragments (never string-built SQL): `${cols(sql)}` / `${colsU(sql)}` inside tagged templates.
const cols = (sql: Sql) => sql`payment_id as "paymentId", tenant_id as "tenantId", plan, amount_inr as "amountInr", reference, mode, gateway_order_id as "gatewayOrderId", utr, status, created_at::text as "createdAt", expires_at::text as "expiresAt", submitted_at::text as "submittedAt", decided_at::text as "decidedAt", decided_by as "decidedBy"`;
const colsU = (sql: Sql) => sql`u.payment_id as "paymentId", u.tenant_id as "tenantId", u.plan, u.amount_inr as "amountInr", u.reference, u.mode, u.gateway_order_id as "gatewayOrderId", u.utr, u.status, u.created_at::text as "createdAt", u.expires_at::text as "expiresAt", u.submitted_at::text as "submittedAt", u.decided_at::text as "decidedAt", u.decided_by as "decidedBy"`;
const one = (rows: readonly unknown[]) => (rows[0] as UpiPayment | undefined) ?? null;

export async function createUpiPayment(sql: Sql, i: { tenantId: string; plan: PlanId; amountInr: number; reference: string; mode: "manual" | "gateway"; expiresInMinutes: number }): Promise<UpiPayment> {
  const rows = await sql`insert into upi_payments (tenant_id, plan, amount_inr, reference, mode, expires_at)
    values (${i.tenantId}, ${i.plan}, ${i.amountInr}, ${i.reference}, ${i.mode}, now() + make_interval(mins => ${i.expiresInMinutes}))
    returning ${cols(sql)}`;
  return rows[0] as unknown as UpiPayment;
}
export async function countOpenUpiPayments(sql: Sql, tenantId: string): Promise<number> {
  const r = await sql<{ n: string }[]>`select count(*)::text as n from upi_payments where tenant_id = ${tenantId} and status in ('PENDING','SUBMITTED') and expires_at > now()`;
  return parseInt(r[0]?.n ?? "0", 10);
}
export async function getUpiPaymentForTenant(sql: Sql, tenantId: string, id: string): Promise<UpiPayment | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one(await sql`select ${cols(sql)} from upi_payments where payment_id = ${id} and tenant_id = ${tenantId}`);
}
export async function getUpiPaymentById(sql: Sql, id: string): Promise<UpiPayment | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one(await sql`select ${cols(sql)} from upi_payments where payment_id = ${id}`);
}
export async function getUpiPaymentByReference(sql: Sql, reference: string): Promise<UpiPayment | null> {
  return one(await sql`select ${cols(sql)} from upi_payments where reference = ${reference}`);
}
export async function setGatewayOrder(sql: Sql, id: string, gatewayOrderId: string): Promise<void> {
  await sql`update upi_payments set gateway_order_id = ${gatewayOrderId} where payment_id = ${id}`;
}
export async function markUpiExpired(sql: Sql, id: string): Promise<void> {
  await sql`update upi_payments set status = 'EXPIRED', decided_at = now(), decided_by = 'system' where payment_id = ${id} and status = 'PENDING'`;
}

/** PENDING → SUBMITTED with the customer's UTR. Returns "used" when that UTR already funds another payment. */
export async function submitUtr(sql: Sql, tenantId: string, id: string, utr: string): Promise<"ok" | "used" | "not_open"> {
  try {
    const r = await sql`update upi_payments set utr = ${utr}, status = 'SUBMITTED', submitted_at = now()
      where payment_id = ${id} and tenant_id = ${tenantId} and mode = 'manual' and status = 'PENDING' and expires_at > now() returning payment_id`;
    return r.length ? "ok" : "not_open";
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return "used";
    throw e;
  }
}

export interface Settled { alreadyDone: boolean; tenantId?: string; plan?: PlanId; oldTier?: string; newTier?: string; upgraded?: boolean }
const TIERS_JSON = JSON.stringify(Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, v.tier])));
const RANKS_JSON = JSON.stringify(TIER_RANK);

/**
 * Atomic and idempotent: ONE statement flips PENDING/SUBMITTED → PAID and raises the tenant's plan (never lowers it).
 * Whoever flips the row first does the work; a duplicate webhook, a poll racing the webhook, or an admin double-click
 * finds no row to flip and gets {alreadyDone: true}.
 */
export async function settleAndUpgrade(sql: Sql, paymentId: string, decidedBy: string): Promise<Settled> {
  const rows = await sql<{ tenantId: string; plan: PlanId; oldTier: string; upgraded: boolean }[]>`
    with p as (
      update upi_payments set status = 'PAID', decided_at = now(), decided_by = ${decidedBy}
      where payment_id = ${paymentId} and status in ('PENDING', 'SUBMITTED')
      returning tenant_id, plan
    ), o as (
      select p.tenant_id, p.plan, t.plan_tier as old_tier from p join tenants t on t.tenant_id = p.tenant_id
    ), u as (
      update tenants t set plan_tier = (${TIERS_JSON}::text::jsonb ->> o.plan), updated_at = now()
      from o where t.tenant_id = o.tenant_id
        and coalesce((${RANKS_JSON}::text::jsonb ->> o.old_tier)::int, 0) < coalesce((${RANKS_JSON}::text::jsonb ->> (${TIERS_JSON}::text::jsonb ->> o.plan))::int, 0)
      returning t.tenant_id
    )
    select o.tenant_id as "tenantId", o.plan, o.old_tier as "oldTier", exists (select 1 from u) as upgraded from o`;
  const r = rows[0];
  if (!r) return { alreadyDone: true };
  return { alreadyDone: false, tenantId: r.tenantId, plan: r.plan, oldTier: r.oldTier, upgraded: r.upgraded, newTier: r.upgraded ? PLANS[r.plan].tier : r.oldTier };
}

export async function rejectUpiPayment(sql: Sql, id: string, by: string): Promise<boolean> {
  const r = await sql`update upi_payments set status = 'REJECTED', decided_at = now(), decided_by = ${by} where payment_id = ${id} and status in ('PENDING','SUBMITTED') returning payment_id`;
  return r.length > 0;
}

export async function listUpiPayments(sql: Sql, status: UpiStatus, limit = 100): Promise<(UpiPayment & { ownerEmail: string; businessName: string })[]> {
  const rows = await sql`select ${colsU(sql)}, t.owner_email as "ownerEmail", t.business_name as "businessName"
    from upi_payments u join tenants t on t.tenant_id = u.tenant_id where u.status = ${status} order by u.created_at desc limit ${Math.min(500, Math.max(1, limit))}`;
  return rows as unknown as (UpiPayment & { ownerEmail: string; businessName: string })[];
}
