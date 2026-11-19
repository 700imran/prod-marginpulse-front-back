// checkRazorpayConfig: the owner's one-call answer to "why aren't real payments working?". Fake Razorpay via patched fetch; no database needed.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkRazorpayConfig } from "../src/billing/razorpayPlan.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const rzp = (status: number) => { const seen: { url: string; auth: string }[] = []; globalThis.fetch = (async (url: any, init: any) => { seen.push({ url: String(url), auth: init?.headers?.Authorization }); return new Response("{}", { status }); }) as any; return seen; };
const env = (o: Record<string, string | undefined>) => ({ RAZORPAY_KEY_ID: "rzp_live_abc", RAZORPAY_KEY_SECRET: "s3cret", RAZORPAY_WEBHOOK_SECRET: "whsec", ...o }) as any;
const text = (r: Awaited<ReturnType<typeof checkRazorpayConfig>>) => r.problems.join(" | ");

test("healthy: live keys accepted by Razorpay + webhook secret set → ok, no problems", async () => {
  const seen = rzp(200);
  const r = await checkRazorpayConfig(env({}));
  assert.deepEqual({ ok: r.ok, keyMode: r.keyMode, keysAccepted: r.keysAccepted, webhookSecretSet: r.webhookSecretSet, problems: r.problems }, { ok: true, keyMode: "live", keysAccepted: true, webhookSecretSet: true, problems: [] });
  assert.equal(seen[0]!.url, "https://api.razorpay.com/v1/orders?count=1");
});

test("never leaks a secret: the report contains the mode and booleans only", async () => {
  rzp(401);
  const out = JSON.stringify(await checkRazorpayConfig(env({ RAZORPAY_KEY_SECRET: "TOPSECRETVALUE", RAZORPAY_WEBHOOK_SECRET: "WEBHOOKSECRETVALUE" })));
  assert.ok(!out.includes("TOPSECRETVALUE") && !out.includes("WEBHOOKSECRETVALUE") && !out.includes("rzp_live_abc"));
});

test("keys missing → says so and does not call Razorpay", async () => {
  const seen = rzp(200);
  const r = await checkRazorpayConfig(env({ RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: "" }));
  assert.equal(r.keyMode, "missing"); assert.equal(r.ok, false); assert.equal(seen.length, 0);
  assert.match(text(r), /not configured/);
});

test("TEST keys → flagged: checkout works but no real money moves", async () => {
  rzp(200);
  const r = await checkRazorpayConfig(env({ RAZORPAY_KEY_ID: "rzp_test_abc" }));
  assert.equal(r.keyMode, "test"); assert.equal(r.ok, false); assert.equal(r.keysAccepted, true);
  assert.match(text(r), /TEST keys/);
});

test("Razorpay answers 401 → mismatched key pair; 403 → account not activated", async () => {
  rzp(401); const a = await checkRazorpayConfig(env({}));
  assert.equal(a.keysAccepted, false); assert.match(text(a), /rejected the key pair/);
  rzp(403); const b = await checkRazorpayConfig(env({}));
  assert.equal(b.keysAccepted, false); assert.match(text(b), /not activated/);
});

test("no webhook secret → flagged even when the keys are fine", async () => {
  rzp(200);
  const r = await checkRazorpayConfig(env({ RAZORPAY_WEBHOOK_SECRET: undefined }));
  assert.equal(r.ok, false); assert.equal(r.webhookSecretSet, false); assert.match(text(r), /RAZORPAY_WEBHOOK_SECRET is not set/);
});

test("Razorpay unreachable / 5xx → keysAccepted is null (unknown), not a false 'wrong keys'", async () => {
  globalThis.fetch = (async () => { throw new Error("network down"); }) as any;
  const a = await checkRazorpayConfig(env({}));
  assert.equal(a.keysAccepted, null); assert.match(text(a), /Could not reach Razorpay/);
  rzp(503); const b = await checkRazorpayConfig(env({}));
  assert.equal(b.keysAccepted, null); assert.match(text(b), /answered 503/);
});
