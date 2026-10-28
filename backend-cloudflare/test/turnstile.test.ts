import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { verifyTurnstile, requireCaptcha, captchaConfigured } from "../src/security/turnstile.ts";
import { publicConfigRoutes } from "../src/routes/publicConfig.ts";
import { registry } from "../src/observability/events.ts";

const ENV: any = { TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", FRONTEND_ORIGIN: "https://app.marginpulse.in" };

function mockCloudflare(reply: (body: URLSearchParams) => { status?: number; json?: unknown } | Error) {
  const real = globalThis.fetch; const seen: URLSearchParams[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String(init.body)); seen.push(body);
    const r = reply(body); if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as any;
  return { seen, restore: () => { globalThis.fetch = real; } };
}
const okReply = (extra: object = {}) => () => ({ json: { success: true, hostname: "app.marginpulse.in", action: "login", ...extra } });

test("valid token for the right host and action passes; secret and client IP are sent to Cloudflare", async () => {
  const m = mockCloudflare(okReply());
  try {
    const r = await verifyTurnstile(ENV, "tok", { action: "login", remoteIp: "203.0.113.9" });
    assert.deepEqual(r, { ok: true });
    assert.equal(m.seen[0]!.get("secret"), ENV.TURNSTILE_SECRET);
    assert.equal(m.seen[0]!.get("response"), "tok");
    assert.equal(m.seen[0]!.get("remoteip"), "203.0.113.9");
    assert.ok(m.seen[0]!.get("idempotency_key"));
  } finally { m.restore(); }
});

test("missing, oversize, rejected, wrong-host and wrong-action tokens are all refused", async () => {
  assert.equal((await verifyTurnstile(ENV, "", { action: "login" })).ok, false);
  const big = await verifyTurnstile(ENV, "x".repeat(3000), { action: "login" });
  assert.equal(big.ok === false && big.status, 400);

  let m = mockCloudflare(() => ({ json: { success: false, "error-codes": ["invalid-input-response"] } }));
  try { const r = await verifyTurnstile(ENV, "bad", { action: "login" }); assert.equal(r.ok === false && r.status, 403); } finally { m.restore(); }

  m = mockCloudflare(okReply({ hostname: "evil.example" }));
  try { const r = await verifyTurnstile(ENV, "t", { action: "login" }); assert.equal(r.ok, false); assert.deepEqual(r.ok === false && r.codes, ["hostname-mismatch"]); } finally { m.restore(); }

  m = mockCloudflare(okReply({ action: "signup" }));   // token minted for the signup form, replayed on login
  try { const r = await verifyTurnstile(ENV, "t", { action: "login" }); assert.equal(r.ok, false); assert.deepEqual(r.ok === false && r.codes, ["action-mismatch"]); } finally { m.restore(); }
});

test("Cloudflare outage fails CLOSED (503), never open", async () => {
  let m = mockCloudflare(() => new Error("network down"));
  try { const r = await verifyTurnstile(ENV, "t", { action: "login" }); assert.equal(r.ok === false && r.status, 503); } finally { m.restore(); }
  m = mockCloudflare(() => ({ status: 500 }));
  try { const r = await verifyTurnstile(ENV, "t", { action: "login" }); assert.equal(r.ok === false && r.status, 503); } finally { m.restore(); }
});

function guarded(skipAuthed = false) {
  const a = new Hono<any>();
  a.use("*", requireCaptcha("roi", skipAuthed ? { skipIf: (c) => c.req.header("Authorization") === "Bearer good" } : {}));
  a.post("/x", (c) => c.json({ ok: true }));
  return a;
}
const hit = (a: Hono<any>, env: any, headers: Record<string, string> = {}) => a.request("/x", { method: "POST", headers }, env);

test("guard: configured → no token 403, valid token 200, bad token 403", async () => {
  assert.equal((await hit(guarded(), ENV)).status, 403);
  let m = mockCloudflare(okReply({ action: "roi" }));
  try { assert.equal((await hit(guarded(), ENV, { "X-Turnstile-Token": "good" })).status, 200); } finally { m.restore(); }
  m = mockCloudflare(() => ({ json: { success: false } }));
  try { const r = await hit(guarded(), ENV, { "X-Turnstile-Token": "bad" }); assert.equal(r.status, 403); assert.equal(((await r.json()) as any).captcha, true); } finally { m.restore(); }
});

test("guard: signed-in callers can skip the challenge; anonymous ones cannot", async () => {
  assert.equal((await hit(guarded(true), ENV, { Authorization: "Bearer good" })).status, 200);
  assert.equal((await hit(guarded(true), ENV, { Authorization: "Bearer forged" })).status, 403);
});

test("guard: unconfigured deployments keep working and the skip is recorded", async () => {
  const before = [...registry.counters.values()].find((c) => c.attrs.event === "captcha" && c.attrs.outcome === "skipped_unconfigured")?.value ?? 0;
  assert.equal((await hit(guarded(), { FRONTEND_ORIGIN: ENV.FRONTEND_ORIGIN })).status, 200);
  const after = [...registry.counters.values()].find((c) => c.attrs.event === "captcha" && c.attrs.outcome === "skipped_unconfigured")!.value;
  assert.equal(after, before + 1);
  assert.equal(captchaConfigured({}), false);
  assert.equal(captchaConfigured({ TURNSTILE_SECRET: "s" }), false); // both key and secret needed
});

test("public config exposes only the site key — never the secret — and only when fully configured", async () => {
  const a = new Hono<any>(); a.route("/config", publicConfigRoutes);
  const on = await a.request("/config/public", {}, ENV);
  const txt = await on.text();
  assert.ok(!txt.includes(ENV.TURNSTILE_SECRET), "secret leaked to the browser");
  const j = JSON.parse(txt);
  assert.equal(j.captcha.enabled, true); assert.equal(j.captcha.siteKey, ENV.TURNSTILE_SITE_KEY);
  const off = JSON.parse(await (await a.request("/config/public", {}, { TURNSTILE_SITE_KEY: "k" })).text());
  assert.equal(off.captcha.enabled, false); assert.equal(off.captcha.siteKey, null);
});
