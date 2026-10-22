#!/usr/bin/env node
// Production smoke test. Talks to a DEPLOYED backend (and optionally the deployed
// frontend) from the outside, the way a browser or monitor would, and exits
// non-zero if anything that should hold doesn't. Used in two places:
//   * deploy-worker.yml, right after `wrangler deploy` — failure triggers a rollback;
//   * by hand:  BACKEND_URL=https://… FRONTEND_URLS=https://app.marginpulse.in node scripts/smoke.mjs
//
// Environment (all optional except BACKEND_URL):
//   BACKEND_URL      the Worker's address, e.g. https://prod-marginpulse-front-back.<acct>.workers.dev
//   FRONTEND_URLS    comma-separated frontend addresses to check (page loads, built for this backend);
//                    each is also CORS-tested unless CORS_ORIGINS is given
//   CORS_ORIGINS     comma-separated origins the backend must ALLOW (defaults to FRONTEND_URLS). Kept
//                    separate so a deploy gate can test the backend alone, without failing on a
//                    frontend that simply hasn't been redeployed yet.
//   SMOKE_TOKEN      a signed-in user's Supabase access token → also runs authenticated checks
//   SMOKE_INCLUDE_AI 1 → also exercises endpoints that call the AI model and spend a credit
//   EXPECT_MUTATIONS "off" (default) | "on" — whether assistant actions should be disabled
//
// Nothing here writes or deletes data. Checks marked WARN don't fail the run.

const REFUSED_ORIGIN = "https://smoke-test-not-allowed.invalid";

export async function runSmoke(opts) {
  const {
    backendUrl, frontendUrls = [], corsOrigins = frontendUrls, token, includeAi = false, expectMutations = "off",
    fetchImpl = globalThis.fetch, timeoutMs = 20000,
  } = opts;
  const base = backendUrl.replace(/\/+$/, "");
  const results = [];

  async function call(method, url, { headers = {}, body } = {}) {
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: ctl.signal, redirect: "manual" });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { res, text, json, ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }
  async function check(name, fn, { warn = false } = {}) {
    const t0 = Date.now();
    try {
      const detail = (await fn()) ?? "";
      results.push({ name, ok: true, warn: false, detail: String(detail), ms: Date.now() - t0 });
    } catch (e) {
      results.push({ name, ok: false, warn, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    }
  }
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  // ── Backend: health & configuration ────────────────────────────────────────
  await check("health: /healthz is 200, database + schema ok", async () => {
    const { res, json, text, ms } = await call("GET", `${base}/healthz`);
    expect(res.status === 200, `HTTP ${res.status} ${text.slice(0, 160)}`);
    expect(json?.status === "ok", `status=${json?.status}`);
    expect(json?.checks?.database?.ok === true, "database check failed");
    expect(json?.checks?.schema?.ok === true, "database schema does not match this build — run db/schema.sql on Supabase");
    expect(!/ECONN|password|postgres(ql)?:\/\//i.test(text), "health response leaks internals");
    return `${ms}ms`;
  });
  await check("health: Redis reachable", async () => {
    const { json } = await call("GET", `${base}/healthz`);
    expect(json?.checks?.redis?.ok === true, "Redis check failed (rate limits/AI budget degrade)");
  }, { warn: true });
  await check("health: row-level security enabled", async () => {
    const { json } = await call("GET", `${base}/healthz`);
    expect(json?.checks?.rls?.ok === true, "RLS not enabled on tenant tables");
  }, { warn: true });
  await check("headers: security headers present", async () => {
    const { res } = await call("GET", `${base}/healthz`);
    for (const [h, v] of [["x-content-type-options", /nosniff/i], ["strict-transport-security", /max-age/i], ["x-frame-options", /deny/i]]) {
      expect(v.test(res.headers.get(h) ?? ""), `missing/incorrect ${h}`);
    }
  });

  // ── Backend: CORS ──────────────────────────────────────────────────────────
  const probe = `${base}/api/v1/reconciliation/dashboard-summary`;
  for (const origin of corsOrigins.map((u) => u.replace(/\/+$/, ""))) {
    await check(`cors: preflight allowed for ${origin}`, async () => {
      const { res } = await call("OPTIONS", probe, { headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
      expect(res.status === 204 || res.status === 200, `HTTP ${res.status}`);
      expect(res.headers.get("access-control-allow-origin") === origin, `Allow-Origin was "${res.headers.get("access-control-allow-origin")}" — add ${origin} to FRONTEND_ORIGIN/ALLOWED_ORIGINS`);
      expect(/authorization/i.test(res.headers.get("access-control-allow-headers") ?? ""), "Authorization header not allowed");
      return res.headers.get("access-control-max-age") ? `max-age ${res.headers.get("access-control-max-age")}s` : "no Max-Age (extra round trip per request)";
    });
  }
  await check("cors: an unlisted origin is refused", async () => {
    const { res } = await call("OPTIONS", probe, { headers: { Origin: REFUSED_ORIGIN, "Access-Control-Request-Method": "GET" } });
    expect(!res.headers.get("access-control-allow-origin"), `unlisted origin was allowed: ${res.headers.get("access-control-allow-origin")}`);
  });

  // ── Backend: authentication is enforced ────────────────────────────────────
  const protectedGets = ["/api/v1/reconciliation/dashboard-summary", "/api/v1/reconciliation/dashboard-insights", "/api/v1/audit-log", "/api/v1/documents"];
  for (const path of protectedGets) {
    await check(`auth: GET ${path} requires a token (401)`, async () => {
      const { res, json } = await call("GET", base + path);
      expect(res.status === 401, `HTTP ${res.status} (expected 401)`);
      expect(typeof json?.error?.code === "string", "401 body is not the standard error envelope");
    });
  }
  await check("auth: POST /api/v1/assistant/message requires a token (401)", async () => {
    const { res } = await call("POST", `${base}/api/v1/assistant/message`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    expect(res.status === 401, `HTTP ${res.status} (expected 401)`);
  });
  await check("auth: a garbage bearer token is rejected (401)", async () => {
    const { res } = await call("GET", probe, { headers: { Authorization: "Bearer not.a.real.token" } });
    expect(res.status === 401, `HTTP ${res.status} (expected 401)`);
  });
  await check("routing: an unknown route is a clean 404, not a crash", async () => {
    const { res } = await call("GET", `${base}/api/v1/definitely-not-a-route`);
    expect(res.status === 404 || res.status === 401, `HTTP ${res.status}`);
  });
  await check("public: POST /api/v1/roi never 5xx on empty input", async () => {
    const { res } = await call("POST", `${base}/api/v1/roi`, { headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status < 500, `HTTP ${res.status}`);
  });

  // ── Backend: authenticated (only with SMOKE_TOKEN) ─────────────────────────
  if (token) {
    const auth = { Authorization: `Bearer ${token}` };
    await check("authed: dashboard-summary?insight=false returns numbers fast", async () => {
      const { res, json, ms } = await call("GET", `${probe}?insight=false`, { headers: auth });
      expect(res.status === 200, `HTTP ${res.status} ${JSON.stringify(json)?.slice(0, 160)}`);
      expect(json?.summaryMetrics && typeof json.summaryMetrics.totalUploadedDocuments === "number", "no summaryMetrics");
      expect(json.plainEnglishInsight === "", "fast mode must not include the AI paragraph");
      return `${ms}ms`;
    });
    await check("authed: dashboard-insights returns data", async () => {
      const { res, json, ms } = await call("GET", `${base}/api/v1/reconciliation/dashboard-insights`, { headers: auth });
      expect(res.status === 200 && json?.generatedAt, `HTTP ${res.status}`);
      return `${ms}ms`;
    });
    await check("authed: audit-log returns { items: [] }", async () => {
      const { res, json } = await call("GET", `${base}/api/v1/audit-log?limit=5`, { headers: auth });
      expect(res.status === 200 && Array.isArray(json?.items), `HTTP ${res.status}`);
    });
    await check(`authed: assistant actions are ${expectMutations.toUpperCase()} (confirm endpoint)`, async () => {
      const { res } = await call("POST", `${base}/api/v1/assistant/confirm`, { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation_token: "bogus" }) });
      if (expectMutations === "off") expect(res.status === 501, `HTTP ${res.status} — expected 501 (mutations disabled)`);
      else expect(res.status === 400, `HTTP ${res.status} — expected 400 (bogus token refused)`);
    });
    if (includeAi) {
      await check("authed: assistant answers a question (spends 1 credit)", async () => {
        const { res, json, ms } = await call("POST", `${base}/api/v1/assistant/message`, { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "How many documents do I have?" }) });
        expect([200, 402, 501].includes(res.status), `HTTP ${res.status}`);
        if (res.status === 200) expect(["text", "confirm_action"].includes(json?.type), `unexpected reply type ${json?.type}`);
        return `HTTP ${res.status} ${ms}ms`;
      });
      await check("authed: dashboard-insight (AI paragraph) responds", async () => {
        const { res, ms } = await call("GET", `${base}/api/v1/reconciliation/dashboard-insight`, { headers: auth });
        expect(res.status === 200, `HTTP ${res.status}`);
        return `${ms}ms`;
      });
    }
  }

  // ── Frontend ───────────────────────────────────────────────────────────────
  const backendHost = new URL(base).host;
  for (const f of frontendUrls.map((u) => u.replace(/\/+$/, ""))) {
    await check(`frontend: ${f} serves the app`, async () => {
      const { res, text, ms } = await call("GET", f + "/");
      expect(res.status === 200, `HTTP ${res.status}`);
      expect(/MarginPulse Pro/.test(text), "page doesn't look like MarginPulse Pro");
      return `${ms}ms`;
    });
    await check(`frontend: ${f} is built to call this backend`, async () => {
      const { text } = await call("GET", f + "/");
      const src = /<script[^>]+src="([^"]*\/static\/js\/main\.[^"]+\.js)"/.exec(text)?.[1];
      expect(src, "couldn't find the main script in the page");
      const js = (await call("GET", new URL(src, f + "/").toString())).text;
      expect(js.includes(backendHost), `the built app doesn't contain ${backendHost} — REACT_APP_API_URL was missing or wrong at build time`);
    });
  }

  const failed = results.filter((r) => !r.ok && !r.warn);
  return { ok: failed.length === 0, results };
}

export function formatReport(results) {
  return results.map((r) => `${r.ok ? "PASS" : r.warn ? "WARN" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`).join("\n");
}

// CLI
const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (import.meta.url === `file://${process.argv[1]}`) {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) { console.error("BACKEND_URL is required"); process.exit(2); }
  const { ok, results } = await runSmoke({
    backendUrl,
    frontendUrls: list(process.env.FRONTEND_URLS),
    corsOrigins: process.env.CORS_ORIGINS === undefined ? undefined : list(process.env.CORS_ORIGINS),
    token: process.env.SMOKE_TOKEN || undefined,
    includeAi: process.env.SMOKE_INCLUDE_AI === "1",
    expectMutations: process.env.EXPECT_MUTATIONS === "on" ? "on" : "off",
  });
  console.log(formatReport(results));
  const f = results.filter((r) => !r.ok && !r.warn).length, w = results.filter((r) => !r.ok && r.warn).length;
  console.log(`\n${results.length - f - w} passed, ${f} failed, ${w} warnings`);
  process.exit(ok ? 0 : 1);
}
