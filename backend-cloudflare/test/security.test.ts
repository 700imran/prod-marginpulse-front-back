// Security regression suite. Each test pins a vulnerability found in the audit
// (or a control that must never silently disappear).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { pickValid, ValidationError, GSTIN_RE } from "../src/security/validate.ts";
import { validateUpload, safeFilename } from "../src/security/upload.ts";
import { constantTimeEqual, isTrustedMediaUrl } from "../src/security/webhookAuth.ts";
import { securityHeaders, corsMiddleware, requestSizeLimit, allowedOrigins } from "../src/middleware/security.ts";
import { updateReconciliationSettings } from "../src/repository/settings.ts";
import { signDownloadToken, verifyDownloadToken } from "../src/storage.ts";
import { app } from "../src/index.ts";

const SRC = path.resolve(import.meta.dirname, "../src");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// ── Input validation (mass assignment / injection) ──────────────────────
test("validator drops unknown keys, __proto__ and SQL-looking keys", () => {
  const evil = JSON.parse('{"fuzzyVendorMatching":true,"__proto__":{"admin":true},"x = 1; drop table tenants; --":1,"processingStatus":"RECONCILED","tenantId":"other"}');
  const out = pickValid(evil, { fuzzyVendorMatching: { t: "bool" } });
  assert.deepEqual(out, { fuzzyVendorMatching: true });
  assert.equal(({} as any).admin, undefined);
});
test("validator enforces types, ranges, formats", () => {
  assert.throws(() => pickValid({ n: "abc" }, { n: { t: "int", min: 0, max: 5 } }), ValidationError);
  assert.throws(() => pickValid({ n: 99 }, { n: { t: "int", min: 0, max: 5 } }), ValidationError);
  assert.throws(() => pickValid({ n: 1.5 }, { n: { t: "int", min: 0, max: 5 } }), ValidationError);
  assert.throws(() => pickValid({ g: "not-a-gstin" }, { g: { t: "str", max: 15, pattern: GSTIN_RE } }), ValidationError);
  assert.throws(() => pickValid({ s: "a\u0000b" }, { s: { t: "str", max: 10 } }), ValidationError);
  assert.throws(() => pickValid({ d: "2026-02-31" }, { d: { t: "date" } }), ValidationError);
  assert.throws(() => pickValid([1], { n: { t: "int", min: 0, max: 5 } }), ValidationError);
  assert.deepEqual(pickValid({ g: "27ABCDE1234F1Z5" }, { g: { t: "str", max: 15, pattern: GSTIN_RE } }), { g: "27ABCDE1234F1Z5" });
});
test("settings repository refuses non-allow-listed column names (SQL injection regression)", async () => {
  const calls: string[] = [];
  const fakeSql: any = { unsafe: async (q: string) => { calls.push(q); } };
  await assert.rejects(updateReconciliationSettings(fakeSql, "t", { ["fuzzy_vendor_matching = true) on conflict do nothing; drop table tenants; --"]: 1 } as any));
  assert.equal(calls.length, 0);
  await updateReconciliationSettings(fakeSql, "t", { fuzzyVendorMatching: false });
  assert.equal(calls.length, 1);
});

// ── Upload validation ───────────────────────────────────────────────────
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
test("uploads: signature must match extension; HTML/EXE disguised as PDF rejected", () => {
  assert.equal(validateUpload("a.pdf", 100, pdf).ok, true);
  const html = new TextEncoder().encode("<html><script>alert(1)</script>");
  assert.equal(validateUpload("invoice.pdf", 100, html).ok, false);
  assert.equal(validateUpload("x.exe", 100, new Uint8Array([0x4d, 0x5a])).ok, false);
  assert.equal(validateUpload("x.svg", 100, html).ok, false);
  assert.equal(validateUpload("x.html", 100, html).ok, false);
  assert.equal(validateUpload("a.pdf", 16 * 1024 * 1024, pdf).ok, false);
  assert.equal(validateUpload("a.pdf", 0, pdf).ok, false);
});
test("safeFilename blocks header injection and path traversal", () => {
  const n = safeFilename('..\\..\\evil"\r\nSet-Cookie: x=1.pdf');
  assert.ok(!/[\\/"\r\n:]/.test(n), n);
  assert.equal(safeFilename(""), "file");
});

// ── Secrets / tokens ────────────────────────────────────────────────────
const KEY = Buffer.alloc(32, 7).toString("base64");
test("download tokens: valid, tampered, expired and NaN-exp all handled", async () => {
  const env: any = { FIELD_ENCRYPTION_KEY: KEY };
  const { token, exp } = await signDownloadToken(env, "t/d/f.pdf", 60);
  assert.equal(await verifyDownloadToken(env, "t/d/f.pdf", token, exp), true);
  assert.equal(await verifyDownloadToken(env, "t/d/other.pdf", token, exp), false); // bound to the object
  assert.equal(await verifyDownloadToken(env, "t/d/f.pdf", token.slice(0, -2) + "xx", exp), false);
  assert.equal(await verifyDownloadToken(env, "t/d/f.pdf", token, exp + 1), false);
  assert.equal(await verifyDownloadToken(env, "t/d/f.pdf", token, NaN), false);
  const old = await signDownloadToken(env, "t/d/f.pdf", -10);
  assert.equal(await verifyDownloadToken(env, "t/d/f.pdf", old.token, old.exp), false);
});
test("constantTimeEqual + media URL SSRF allow-list", async () => {
  assert.equal(await constantTimeEqual("abc", "abc"), true);
  assert.equal(await constantTimeEqual("abc", "abd"), false);
  assert.equal(await constantTimeEqual("abc", "abcd"), false);
  assert.equal(isTrustedMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/x"), true);
  assert.equal(isTrustedMediaUrl("http://lookaside.fbsbx.com/x"), false);
  assert.equal(isTrustedMediaUrl("https://evil.com/fbcdn.net"), false);
  assert.equal(isTrustedMediaUrl("https://fbcdn.net.evil.com/x"), false);
  assert.equal(isTrustedMediaUrl("https://169.254.169.254/latest/meta-data"), false);
});

// ── HTTP hardening ──────────────────────────────────────────────────────
test("headers, CORS allow-list and body limit", async () => {
  const a = new Hono<any>();
  a.use("*", securityHeaders, corsMiddleware(), requestSizeLimit);
  a.get("/x", (c) => c.json({ ok: 1 }));
  a.post("/x", async (c) => c.json({ len: (await c.req.text()).length }));
  const env: any = { FRONTEND_ORIGIN: "https://app.marginpulse.in, https://marginpulse.in/" };
  assert.deepEqual(allowedOrigins(env), ["https://app.marginpulse.in", "https://marginpulse.in"]);

  const ok = await a.request("/x", { headers: { Origin: "https://app.marginpulse.in" } }, env);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.marginpulse.in");
  assert.equal(ok.headers.get("vary"), "Origin");
  assert.match(ok.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.ok(ok.headers.get("strict-transport-security")!.includes("max-age"));

  const bad = await a.request("/x", { headers: { Origin: "https://evil.example" } }, env);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  assert.equal(bad.headers.get("access-control-allow-credentials"), null);

  const big = await a.request("/x", { method: "POST", body: "a".repeat(300 * 1024), headers: { "content-length": String(300 * 1024) } }, env);
  assert.equal(big.status, 413);
  const small = await a.request("/x", { method: "POST", body: "hello" }, env);
  assert.equal(small.status, 200);
});

// ── Whole-app auth coverage ─────────────────────────────────────────────
const ENV: any = {
  ENVIRONMENT: "production", SUPABASE_URL: "https://proj.supabase.co", FRONTEND_ORIGIN: "https://app.marginpulse.in",
  HYPERDRIVE: { connectionString: "postgres://u:p@127.0.0.1:1/db" },
  UPSTASH_REDIS_REST_URL: "https://upstash.invalid", UPSTASH_REDIS_REST_TOKEN: "t",
  FIELD_ENCRYPTION_KEY: KEY, WHATSAPP_APP_SECRET: "", WEBHOOK_INGEST_SECRET: "", RAZORPAY_WEBHOOK_SECRET: "whsec", RAZORPAY_KEY_SECRET: "k", RAZORPAY_KEY_ID: "id", WHATSAPP_VERIFY_TOKEN: "",
};
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = (async () => new Response(JSON.stringify({ result: 1 }), { status: 200 })) as any; });
after(() => { globalThis.fetch = realFetch; });

// Public by design: ROI calculator (pure arithmetic) and the Slack OAuth redirect target (protected by a one-time CSRF state).
// Intentionally public: ROI (guarded by Turnstile for anonymous callers), OAuth callback, and the login screen's
// captcha site-key lookup (public value only, covered by turnstile.test.ts).
const PUBLIC = new Set(["/api/v1/roi", "/api/v1/roi/", "/api/v1/integrations/slack/callback", "/api/v1/config/public"]);
test("every /api/v1 route rejects requests without a bearer token (401)", async () => {
  const routes = app.routes.filter((r) => r.path.startsWith("/api/v1") && r.method !== "ALL" && !PUBLIC.has(r.path));
  assert.ok(routes.length > 30, `expected many routes, got ${routes.length}`);
  const seen = new Set<string>();
  for (const r of routes) {
    const url = r.path.replace(/:[A-Za-z]+/g, "00000000-0000-0000-0000-000000000000").replace(/\/\*$/, "");
    const key = `${r.method} ${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await app.fetch(new Request(`https://api.test${url}`, { method: r.method, body: r.method === "GET" || r.method === "DELETE" ? undefined : "{}", headers: { "content-type": "application/json" } }), ENV, CTX);
    assert.equal(res.status, 401, `${key} returned ${res.status} without auth`);
  }
});
test("forged / malformed bearer tokens are rejected", async () => {
  for (const h of ["Bearer ", "Bearer abc", "Bearer a.b.c", "Basic Zm9vOmJhcg==", "bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."]) {
    const res = await app.fetch(new Request("https://api.test/api/v1/documents", { headers: { Authorization: h } }), ENV, CTX);
    assert.equal(res.status, 401, h);
  }
});
test("webhooks fail closed when their secrets are not configured", async () => {
  const wa = await app.fetch(new Request("https://api.test/webhook/whatsapp", { method: "POST", body: "{}" }), ENV, CTX);
  assert.equal(wa.status, 503);
  const em = await app.fetch(new Request("https://api.test/webhook/email-ingest", { method: "POST", body: "{}" }), ENV, CTX);
  assert.equal(em.status, 503);
  const handshake = await app.fetch(new Request("https://api.test/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=x"), ENV, CTX);
  assert.equal(handshake.status, 403); // empty configured token must not match an empty query token
  const rz = await app.fetch(new Request("https://api.test/api/razorpay/webhook", { method: "POST", body: "{}", headers: { "X-Razorpay-Signature": "00" } }), ENV, CTX);
  assert.equal(rz.status, 400);
});
test("slack callback without a valid one-time state never connects anything", async () => {
  const res = await app.fetch(new Request("https://api.test/api/v1/integrations/slack/callback?code=x&state=forged"), ENV, CTX);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location")!, /status=error/);
});
test("errors never leak internals and health does not disclose environment", async () => {
  const h = await app.fetch(new Request("https://api.test/healthz"), ENV, CTX);
  assert.deepEqual(await h.json(), { status: "ok" });
  const nf = await app.fetch(new Request("https://api.test/does-not-exist"), ENV, CTX);
  assert.equal(nf.status, 404);
});

// ── Static guards ───────────────────────────────────────────────────────
test("every public table is covered by the RLS migration", () => {
  const schema = fs.readFileSync(path.resolve(SRC, "../db/schema.sql"), "utf8");
  const mig = fs.readFileSync(path.resolve(SRC, "../db/002_security_hardening.sql"), "utf8");
  const tables = [...schema.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]!);
  assert.ok(tables.length >= 13);
  for (const t of tables) assert.match(mig, new RegExp(`alter table public\\.${t}\\s+enable row level security`), `RLS missing for ${t}`);
});
test("no hard-coded secrets in source", () => {
  const patterns = [/sk_live_[A-Za-z0-9]{10,}/, /rzp_live_[A-Za-z0-9]{8,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /github_pat_[A-Za-z0-9_]{20,}/, /xox[bp]-[A-Za-z0-9-]{10,}/];
  for (const f of walk(SRC).filter((f) => /\.(ts|toml|json)$/.test(f))) {
    const txt = fs.readFileSync(f, "utf8");
    for (const p of patterns) assert.ok(!p.test(txt), `possible secret in ${f}: ${p}`);
  }
});
test("raw SQL (sql.unsafe) never interpolates variables into the statement text", () => {
  // Allowed: ${sets.join}/${table}-style identifiers ONLY in the files with allow-list guards.
  const guarded = new Set(["repository/settings.ts", "repository/platformSettings.ts", "repository/documents.ts", "repository/bankTransactions.ts", "auth/supabase.ts"]);
  for (const f of walk(SRC).filter((f) => f.endsWith(".ts"))) {
    const rel = path.relative(SRC, f);
    const txt = fs.readFileSync(f, "utf8");
    for (const m of txt.matchAll(/\.unsafe(?:<[^>]*>)?\(\s*`([^`]*)`/g)) {
      const interpolations = [...m[1]!.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]!.trim());
      const risky = interpolations.filter((i) => !/^(SELECT|TENANT_COLS|params\.length( - 1)?|[a-zA-Z]*\.join\(", "\)|table|setClause|insertCols|insertPlaceholders|sets\.join\(", "\))$/.test(i));
      assert.ok(risky.length === 0 || guarded.has(rel), `${rel}: unsafe() interpolates ${risky.join(", ")}`);
      assert.deepEqual(risky.filter((i) => /req|body|query|param|input|c\./.test(i)), [], `${rel}: unsafe() interpolates request data`);
    }
  }
});

test("validator treats null as not-provided (frontend sends label: null)", () => {
  assert.deepEqual(pickValid({ label: null, id_value: "27ABCDE1234F1Z5" }, { label: { t: "str", max: 10, allowEmpty: true }, id_value: { t: "str", max: 30 } }), { id_value: "27ABCDE1234F1Z5" });
});
