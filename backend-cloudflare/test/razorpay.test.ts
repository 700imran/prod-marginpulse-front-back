import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyCheckoutSignature, verifyWebhookSignature, createRazorpayOrder, fetchRazorpayPayment } from "../src/billing/razorpay";

const hmac = (secret: string, msg: string) => createHmac("sha256", secret).update(msg).digest("hex");

describe("checkout signature (order_id|payment_id)", () => {
  const secret = "key_secret_123";
  it("accepts a correctly signed callback (signature computed independently with node:crypto)", async () => {
    expect(await verifyCheckoutSignature(secret, "order_ABC123", "pay_XYZ789", hmac(secret, "order_ABC123|pay_XYZ789"))).toBe(true);
  });
  it("rejects wrong secret, swapped ids, tampered ids", async () => {
    const sig = hmac(secret, "order_ABC123|pay_XYZ789");
    expect(await verifyCheckoutSignature("other", "order_ABC123", "pay_XYZ789", sig)).toBe(false);
    expect(await verifyCheckoutSignature(secret, "pay_XYZ789", "order_ABC123", sig)).toBe(false);
    expect(await verifyCheckoutSignature(secret, "order_ABC124", "pay_XYZ789", sig)).toBe(false);
    expect(await verifyCheckoutSignature(secret, "order_ABC123", "pay_XYZ780", sig)).toBe(false);
  });
  it("rejects empty / non-hex / odd-length / truncated signatures and an empty secret", async () => {
    const sig = hmac(secret, "o|p");
    for (const bad of ["", "zz", "abc", sig.slice(0, -2), sig + "00", "0x" + sig, null, undefined]) expect(await verifyCheckoutSignature(secret, "o", "p", bad as any)).toBe(false);
    expect(await verifyCheckoutSignature("", "o", "p", hmac("", "o|p"))).toBe(false);
  });
});

describe("webhook signature (raw body)", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", amount: 99900 } } } });
  it("accepts the exact body, and is case-insensitive about hex", async () => {
    expect(await verifyWebhookSignature(secret, body, hmac(secret, body))).toBe(true);
    expect(await verifyWebhookSignature(secret, body, hmac(secret, body).toUpperCase())).toBe(true);
  });
  it("rejects any change to the body — even whitespace — or the wrong secret", async () => {
    const sig = hmac(secret, body);
    expect(await verifyWebhookSignature(secret, body + " ", sig)).toBe(false);
    expect(await verifyWebhookSignature(secret, body.replace("99900", "100"), sig)).toBe(false);
    expect(await verifyWebhookSignature("nope", body, sig)).toBe(false);
    expect(await verifyWebhookSignature(secret, body, null)).toBe(false);
  });
});

describe("createRazorpayOrder", () => {
  const env = { RAZORPAY_KEY_ID: "rzp_test_id", RAZORPAY_KEY_SECRET: "rzp_secret" };
  const fake = (status: number, body: any) => (async (url: string, init: any) => { (fake as any).last = { url, init }; return new Response(JSON.stringify(body), { status }); }) as any;
  it("sends our amount in paise with Basic auth and returns the order", async () => {
    const f = fake(200, { id: "order_1", amount: 99900, currency: "INR" });
    const o = await createRazorpayOrder(env, { amountPaise: 99900, receipt: "r".repeat(60), notes: { tenant_id: "t", plan: "STARTER" } }, f);
    expect(o).toEqual({ id: "order_1", amount: 99900, currency: "INR" });
    const { url, init } = (fake as any).last;
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(init.headers.Authorization).toBe(`Basic ${btoa("rzp_test_id:rzp_secret")}`);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ amount: 99900, currency: "INR", notes: { plan: "STARTER" } });
    expect(sent.receipt.length).toBeLessThanOrEqual(40);   // Razorpay's limit
  });
  it("refuses a response whose amount or currency isn't what we asked for", async () => {
    await expect(createRazorpayOrder(env, { amountPaise: 99900, receipt: "r", notes: {} }, fake(200, { id: "o", amount: 100, currency: "INR" }))).rejects.toThrow();
    await expect(createRazorpayOrder(env, { amountPaise: 99900, receipt: "r", notes: {} }, fake(200, { id: "o", amount: 99900, currency: "USD" }))).rejects.toThrow();
  });
  it("throws on HTTP errors and malformed bodies, never returning a half-order", async () => {
    await expect(createRazorpayOrder(env, { amountPaise: 1, receipt: "r", notes: {} }, fake(401, { error: { description: "Authentication failed" } }))).rejects.toThrow(/Authentication failed/);
    await expect(createRazorpayOrder(env, { amountPaise: 1, receipt: "r", notes: {} }, fake(200, {}))).rejects.toThrow();
  });
});

describe("fetchRazorpayPayment", () => {
  const env = { RAZORPAY_KEY_ID: "id", RAZORPAY_KEY_SECRET: "sec" };
  it("returns the provider's view of the payment", async () => {
    const f = (async () => new Response(JSON.stringify({ id: "pay_1", order_id: "order_1", amount: 5, currency: "INR", status: "captured" }))) as any;
    expect(await fetchRazorpayPayment(env, "pay_1", f)).toEqual({ id: "pay_1", order_id: "order_1", amount: 5, currency: "INR", status: "captured" });
  });
  it("rejects a response about a different payment than the one asked for", async () => {
    const f = (async () => new Response(JSON.stringify({ id: "pay_OTHER", order_id: "o", amount: 5, currency: "INR", status: "captured" }))) as any;
    await expect(fetchRazorpayPayment(env, "pay_1", f)).rejects.toThrow();
  });
  it("encodes the id in the URL (no path injection)", async () => {
    let seen = "";
    const f = (async (u: string) => { seen = u; return new Response("{}", { status: 404 }); }) as any;
    await expect(fetchRazorpayPayment(env, "../../orders", f)).rejects.toThrow();
    expect(seen).toBe("https://api.razorpay.com/v1/payments/..%2F..%2Forders");
  });
});
