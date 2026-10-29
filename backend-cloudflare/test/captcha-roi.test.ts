// End-to-end captcha behaviour of the public ROI route with REAL JWT verification (jose, ES256),
// a real JWKS document, and a mocked Cloudflare siteverify. Proves who is exempt and who is challenged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { roiRoutes } from "../src/routes/roi.ts";

// jose fetches JWKS with node:http(s) in Node (and global fetch inside Workers), so serve a REAL JWKS
// from a local HTTP server instead of mocking fetch — otherwise verification would fail for the wrong reason.
let SUPABASE_URL = "";
const ENV: any = { SUPABASE_URL, FRONTEND_ORIGIN: "https://app.marginpulse.in", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA" };
let good: CryptoKey, bad: CryptoKey; const realFetch = globalThis.fetch; let server: http.Server;
let siteverifyCalls = 0; let siteverifyReply: object = { success: true, hostname: "app.marginpulse.in", action: "roi" };

before(async () => {
  const a = await generateKeyPair("ES256"); const b = await generateKeyPair("ES256");
  good = a.privateKey as CryptoKey; bad = b.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  SUPABASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  ENV.SUPABASE_URL = SUPABASE_URL;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("challenges.cloudflare.com")) { siteverifyCalls++; return new Response(JSON.stringify(siteverifyReply)); }
    return realFetch(url, init);
  }) as any;
});
after(() => { globalThis.fetch = realFetch; server.close(); });

const mint = (key: CryptoKey, o: { aud?: string; exp?: string } = {}) =>
  new SignJWT({ email: "asha@acme.in", role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("11111111-2222-3333-4444-555555555555")
    .setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience(o.aud ?? "authenticated").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(key);

test("sanity: the verifier accepts the genuine token (so the rejections below are for the right reason)", async () => {
  const { verifySupabaseToken } = await import("../src/auth/supabase.ts");
  const claims = await verifySupabaseToken(ENV, await mint(good));
  assert.equal(claims.email, "asha@acme.in");
  for (const t of [await mint(bad), await mint(good, { exp: "-1m" }), await mint(good, { aud: "anon" })]) await assert.rejects(() => verifySupabaseToken(ENV, t));
});

const app = () => { const a = new Hono<any>(); a.route("/roi", roiRoutes); return a; };
const body = JSON.stringify({ monthly_invoice_volume: 1000, avg_invoice_value_inr: 50000, hours_spent_manually_per_month: 80, hourly_cost_inr: 500, monthly_plan_price_inr: 4999 });
const call = (headers: Record<string, string> = {}) => app().request("/roi", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }, ENV);

test("anonymous caller without a token is challenged (403, captcha flag) and Cloudflare is not even called", async () => {
  siteverifyCalls = 0;
  const r = await call();
  assert.equal(r.status, 403); assert.equal(((await r.json()) as any).captcha, true); assert.equal(siteverifyCalls, 0);
});

test("anonymous caller with a valid Turnstile token gets the calculation", async () => {
  siteverifyReply = { success: true, hostname: "app.marginpulse.in", action: "roi" };
  const r = await call({ "X-Turnstile-Token": "good" });
  assert.equal(r.status, 200);
  assert.ok(((await r.json()) as any).results.total_monthly_value_inr > 0);
});

test("token minted for another action (login) cannot be replayed on ROI", async () => {
  siteverifyReply = { success: true, hostname: "app.marginpulse.in", action: "login" };
  assert.equal((await call({ "X-Turnstile-Token": "replayed" })).status, 403);
});

test("signed-in user with a genuine Supabase JWT skips the challenge entirely", async () => {
  siteverifyCalls = 0;
  const r = await call({ Authorization: `Bearer ${await mint(good)}` });
  assert.equal(r.status, 200); assert.equal(siteverifyCalls, 0);
});

test("forged, expired and wrong-audience tokens do NOT earn the exemption", async () => {
  siteverifyCalls = 0;
  for (const tok of [await mint(bad), await mint(good, { exp: "-1m" }), await mint(good, { aud: "anon" }), "not.a.jwt"]) {
    const r = await call({ Authorization: `Bearer ${tok}` });
    assert.equal(r.status, 403, "must be challenged");
  }
  assert.equal(siteverifyCalls, 0);
});
