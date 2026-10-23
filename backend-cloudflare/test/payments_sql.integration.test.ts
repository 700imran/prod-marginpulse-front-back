// Plan activation against a real Postgres loaded with db/schema.sql. Skipped
// unless PG_TEST_URL is set.  PG_TEST_URL=postgres://postgres:pw@localhost/mp
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { insertPaymentOrder, activatePaidOrder, currentPlanOf } from "../src/repository/payments";
import { monthlyAllowanceForPlan } from "../src/billing/pricing";

const url = process.env.PG_TEST_URL;
const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

describe.skipIf(!url)("payments activation (real Postgres)", () => {
  const sql = postgres(url ?? "postgres://x", { max: 1 }) as any;
  const sql2 = postgres(url ?? "postgres://x", { max: 1 }) as any; // a second connection, for the concurrency test
  let seq = 0;
  const newOrder = async (tenant: string, plan: "STARTER" | "GROWTH" | "ENTERPRISE", paise = 49900) => {
    const id = `order_T${++seq}${Date.now()}`;
    await insertPaymentOrder(sql, { tenantId: tenant, plan, months: 1, amountPaise: paise, razorpayOrderId: id });
    return id;
  };
  const tenantRow = async (id: string) => (await sql`select plan_tier, plan_expires_at from tenants where tenant_id = ${id}`)[0];
  const wallet = async (id: string) => (await sql`select balance_credits::int as bal, monthly_allowance_credits::int as allowance from credit_wallets where tenant_id = ${id}`)[0];
  const ledger = async (id: string) => await sql`select entry_type, amount_credits::int as amt, idempotency_key from credit_ledger where tenant_id = ${id} and entry_type = 'PURCHASE'`;
  const pay = (order: string, over: any = {}) => ({ razorpayOrderId: order, paymentId: `pay_${order}`, amountPaise: 49900, currency: "INR", ...over });

  beforeAll(async () => {
    for (const [id, e] of [[A, "a@x.in"], [B, "b@x.in"]]) await sql`insert into auth.users (id, email) values (${id}, ${e}) on conflict do nothing`;
  });
  beforeEach(async () => {
    await sql`delete from payment_orders`; await sql`delete from credit_ledger`; await sql`delete from credit_wallets`;
    await sql`update tenants set plan_tier = 'FREE', plan_expires_at = null`;
  });
  afterAll(async () => { await sql.end(); await sql2.end(); });

  it("a confirmed payment activates the plan for 30 days, grants the extra credits, and records it", async () => {
    const o = await newOrder(A, "STARTER");
    const r: any = await activatePaidOrder(sql, pay(o));
    expect(r).toMatchObject({ status: "ACTIVATED", plan: "STARTER", tenantId: A });
    const t = await tenantRow(A);
    expect(t.plan_tier).toBe("STARTER");
    const days = (new Date(t.plan_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1);
    const delta = monthlyAllowanceForPlan("STARTER") - monthlyAllowanceForPlan("FREE");
    expect(r.creditsGranted).toBe(delta);
    expect((await wallet(A)).allowance).toBe(monthlyAllowanceForPlan("STARTER"));
    expect(await ledger(A)).toEqual([{ entry_type: "PURCHASE", amt: delta, idempotency_key: expect.stringMatching(/^plan_purchase:/) }]);
    const [o2] = await sql`select status, razorpay_payment_id, paid_at from payment_orders where razorpay_order_id = ${o}`;
    expect(o2.status).toBe("PAID"); expect(o2.razorpay_payment_id).toBe(`pay_${o}`); expect(o2.paid_at).not.toBeNull();
  });

  it("is idempotent: the same payment delivered again (webhook retry / browser + webhook) changes nothing", async () => {
    const o = await newOrder(A, "STARTER");
    await activatePaidOrder(sql, pay(o));
    const before = { t: await tenantRow(A), w: await wallet(A), l: (await ledger(A)).length };
    for (let i = 0; i < 3; i++) expect(await activatePaidOrder(sql, pay(o))).toEqual({ status: "ALREADY_PAID" });
    expect(await tenantRow(A)).toEqual(before.t);
    expect(await wallet(A)).toEqual(before.w);
    expect((await ledger(A)).length).toBe(before.l);
  });

  it("two simultaneous deliveries on separate connections: exactly one activates, credits granted once", async () => {
    const o = await newOrder(A, "GROWTH", 149900);
    const results: any[] = await Promise.all([
      activatePaidOrder(sql, pay(o, { amountPaise: 149900 })),
      activatePaidOrder(sql2, pay(o, { amountPaise: 149900 })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["ACTIVATED", "ALREADY_PAID"]);
    const entries = await ledger(A);
    expect(entries.length).toBe(1);
    expect(entries[0].amt).toBe(monthlyAllowanceForPlan("GROWTH") - monthlyAllowanceForPlan("FREE"));  // granted once, not twice
  });

  it("a delivery that overlaps an in-flight activation waits for it, then sees PAID and grants nothing (the double-spend case)", async () => {
    const o = await newOrder(A, "STARTER");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // A webhook that has already marked the order PAID but not yet committed.
    const holder = sql2.begin(async (tx: any) => {
      await tx`update payment_orders set status = 'PAID', razorpay_payment_id = ${`pay_${o}`}, paid_at = now() where razorpay_order_id = ${o}`;
      await gate;
    });
    await new Promise((r) => setTimeout(r, 150));
    let finished = false;
    const second = activatePaidOrder(sql, pay(o)).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 500));
    expect(finished).toBe(false);                      // it is waiting for the other transaction, not racing past it
    release(); await holder;
    // Without the row lock the second call would read the still-uncommitted CREATED state and activate AGAIN.
    expect(await second).toEqual({ status: "ALREADY_PAID" });
    expect((await ledger(A)).length).toBe(0);
    expect((await tenantRow(A)).plan_tier).toBe("FREE");
  });

  it("refuses a payment whose amount or currency differs from what the server stored — nothing changes", async () => {
    const o = await newOrder(A, "STARTER", 49900);
    expect(await activatePaidOrder(sql, pay(o, { amountPaise: 100 }))).toEqual({ status: "AMOUNT_MISMATCH" });
    expect(await activatePaidOrder(sql, pay(o, { currency: "USD" }))).toEqual({ status: "AMOUNT_MISMATCH" });
    expect((await tenantRow(A)).plan_tier).toBe("FREE");
    expect((await sql`select status from payment_orders where razorpay_order_id = ${o}`)[0].status).toBe("CREATED");
    expect((await ledger(A)).length).toBe(0);
    expect(await activatePaidOrder(sql, pay(o))).toMatchObject({ status: "ACTIVATED" }); // the genuine payment still works afterwards
  });

  it("another tenant can't claim someone else's order; unknown orders are reported, not created", async () => {
    const o = await newOrder(A, "STARTER");
    expect(await activatePaidOrder(sql, pay(o, { expectTenantId: B }))).toEqual({ status: "WRONG_TENANT" });
    expect((await tenantRow(A)).plan_tier).toBe("FREE"); expect((await tenantRow(B)).plan_tier).toBe("FREE");
    expect(await activatePaidOrder(sql, pay("order_DOES_NOT_EXIST"))).toEqual({ status: "UNKNOWN_ORDER" });
  });

  it("amountPaise: null (amount already confirmed with the provider) skips only the amount comparison", async () => {
    const o = await newOrder(A, "STARTER");
    expect(await activatePaidOrder(sql, pay(o, { amountPaise: null }))).toMatchObject({ status: "ACTIVATED" });
  });

  it("renewing the same plan extends from the current expiry; upgrading to another plan starts a fresh 30 days", async () => {
    const o1 = await newOrder(A, "STARTER"); const r1: any = await activatePaidOrder(sql, pay(o1));
    const o2 = await newOrder(A, "STARTER"); const r2: any = await activatePaidOrder(sql, pay(o2));
    const gap = (new Date(r2.expiresAt).getTime() - new Date(r1.expiresAt).getTime()) / 86_400_000;
    expect(gap).toBeGreaterThan(29.9); expect(gap).toBeLessThan(30.1);                 // 60 days total, not 30 again from now
    expect(r2.creditsGranted).toBe(0);                                                  // renewing grants no new allowance
    const o3 = await newOrder(A, "GROWTH", 149900); const r3: any = await activatePaidOrder(sql, pay(o3, { amountPaise: 149900 }));
    expect(r3.plan).toBe("GROWTH");
    const days = (new Date(r3.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1);
    expect(r3.creditsGranted).toBe(monthlyAllowanceForPlan("GROWTH") - monthlyAllowanceForPlan("STARTER"));
  });

  it("an expired plan reads as FREE; a plan with no expiry (set by hand) is left alone", async () => {
    await sql`update tenants set plan_tier = 'GROWTH', plan_expires_at = now() - interval '1 day' where tenant_id = ${A}`;
    expect(await currentPlanOf(sql, A)).toBe("FREE");
    await sql`update tenants set plan_tier = 'ENTERPRISE', plan_expires_at = null where tenant_id = ${B}`;
    expect(await currentPlanOf(sql, B)).toBe("ENTERPRISE");
    await sql`update tenants set plan_tier = 'GROWTH', plan_expires_at = now() + interval '1 day' where tenant_id = ${A}`;
    expect(await currentPlanOf(sql, A)).toBe("GROWTH");
  });

  it("a provider payment id can't be used to activate two different orders (and the failed attempt leaves no trace)", async () => {
    const o1 = await newOrder(A, "STARTER"); const o2 = await newOrder(B, "STARTER");
    await activatePaidOrder(sql, { ...pay(o1), paymentId: "pay_SAME" });
    await expect(activatePaidOrder(sql, { ...pay(o2), paymentId: "pay_SAME" })).rejects.toThrow();
    expect((await tenantRow(B)).plan_tier).toBe("FREE");
    expect((await sql`select status from payment_orders where razorpay_order_id = ${o2}`)[0].status).toBe("CREATED");
    expect((await ledger(B)).length).toBe(0);
  });

  it("a duplicate provider order id can't be stored twice", async () => {
    const o = await newOrder(A, "STARTER");
    await expect(insertPaymentOrder(sql, { tenantId: B, plan: "STARTER", months: 1, amountPaise: 49900, razorpayOrderId: o })).rejects.toThrow();
  });

  it("row-level security: a tenant-scoped connection sees only its own orders", async () => {
    await newOrder(A, "STARTER"); await newOrder(B, "STARTER");
    const seen = await sql.begin(async (tx: any) => {
      await tx`set local role app_user`;
      await tx`select set_config('app.tenant_id', ${A}, true)`;
      return await tx`select tenant_id from payment_orders`;
    });
    expect(seen.map((r: any) => r.tenant_id)).toEqual([A]);
  });
});
