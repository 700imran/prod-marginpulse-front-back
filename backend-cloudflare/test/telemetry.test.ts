import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Registry, buildMetricsPayload, buildTracesPayload, maybeFlush, safeLabel, BOUNDS_SECONDS } from "../src/observability/metrics.ts";
import { registry, emit } from "../src/observability/events.ts";
import { telemetry, telemetryIngest } from "../src/observability/telemetry.ts";

test("histogram buckets, sum and count are right", () => {
  const r = new Registry();
  [0.004, 0.02, 0.3, 12].forEach((v) => r.observe("http.server.request.duration", "s", v, { route: "/x" }));
  const h = [...r.hists.values()][0]!;
  assert.equal(h.count, 4);
  assert.ok(Math.abs(h.sum - 12.324) < 1e-9);
  assert.equal(h.buckets.length, BOUNDS_SECONDS.length + 1);
  assert.equal(h.buckets[0], 1); // 0.004 <= 0.005
  assert.equal(h.buckets[h.buckets.length - 1], 1); // 12 > 10 → +Inf bucket
  r.observe("x", "s", -1); r.observe("x", "s", NaN); // garbage is ignored
  assert.equal(r.hists.size, 1);
});

test("OTLP metrics payload: cumulative temporality, int64 as strings, instance id present", () => {
  const r = new Registry();
  r.inc("marginpulse.events", { event: "payment", outcome: "verified" }, 3);
  r.observe("http.server.request.duration", "s", 0.05, { route: "/api/v1/documents" });
  const p = buildMetricsPayload(r, "production") as any;
  const res = p.resourceMetrics[0].resource.attributes.map((a: any) => a.key);
  assert.ok(res.includes("service.name") && res.includes("service.instance.id"));
  const ms = p.resourceMetrics[0].scopeMetrics[0].metrics;
  const hist = ms.find((m: any) => m.histogram).histogram;
  assert.equal(hist.aggregationTemporality, 2);
  assert.equal(typeof hist.dataPoints[0].count, "string");
  assert.equal(hist.dataPoints[0].bucketCounts.length, hist.dataPoints[0].explicitBounds.length + 1);
  const sum = ms.find((m: any) => m.sum).sum;
  assert.equal(sum.isMonotonic, true);
  assert.equal(sum.dataPoints[0].asInt, "3");
});

test("OTLP traces payload uses hex ids and error status", () => {
  const r = new Registry();
  const p = buildTracesPayload(r, "production", [{ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "GET /x", startMs: 1000, endMs: 1050, attrs: { "http.response.status_code": 500 }, error: true }]) as any;
  const s = p.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(s.traceId.length, 32); assert.equal(s.spanId.length, 16);
  assert.equal(s.status.code, 2);
  assert.equal(s.endTimeUnixNano, "1050000000");
});

test("labels cannot carry PII or free text", () => {
  assert.equal(safeLabel("asha@acme.in"), "other");
  assert.equal(safeLabel("Acme Traders Pvt Ltd"), "other");
  assert.equal(safeLabel("verified"), "verified");
  emit("payment", { outcome: "user@example.com" });
  const keys = [...registry.counters.keys()].join("\n");
  assert.ok(!keys.includes("@"));
});

const ENV: any = { ENVIRONMENT: "production", OTLP_ENDPOINT: "https://otlp.test/otlp/", OTLP_HEADERS: "Authorization=Basic%20abc123,X-Scope=mp" };
function app() {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { c.set("requestId", "req-12345678"); await next(); });
  a.use("*", telemetry);
  a.get("/api/v1/documents/:id", (c) => { c.set("tenant", { tenantId: "tenant-secret-uuid", planTier: "GROWTH", ownerEmail: "asha@acme.in" }); return c.json({ ok: true }); });
  a.get("/api/v1/boom", () => { throw new Error("db password is hunter2"); });
  a.onError((e, c) => c.json({ error: "internal" }, 500));
  return a;
}

test("middleware: route label is the pattern (not the raw id), logs carry no PII, export carries auth headers", async () => {
  const logs: string[] = []; const real = console.log; console.log = (m: any) => logs.push(String(m));
  const calls: any[] = []; const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); }) as any;
  try {
    registry.lastFlush = 0;
    const a = app();
    await a.request("/api/v1/documents/9f1c2c9a-aaaa-bbbb-cccc-1234567890ab", {}, ENV);
    await a.request("/api/v1/boom", {}, ENV);
    await a.request("/definitely/not/a/route/with/secret-123456", {}, ENV);
    await new Promise((r) => setTimeout(r, 20));
    await maybeFlush(registry, ENV, true); // spans queued after the throttled flush go out on the next one
  } finally { console.log = real; globalThis.fetch = realFetch; }

  const routes = [...registry.hists.values()].filter((h) => h.name === "http.server.request.duration").map((h) => h.attrs["http.route"]);
  assert.ok(routes.includes("/api/v1/documents/:id"), `routes: ${routes}`);
  assert.ok(routes.includes("unmatched"), "404 must not leak raw paths into labels");
  assert.ok(!routes.some((r) => /9f1c2c9a|secret-123456/.test(r!)));
  const plans = [...registry.hists.values()].map((h) => h.attrs.plan);
  assert.ok(plans.includes("growth"));

  const joined = logs.join("\n");
  assert.ok(!joined.includes("tenant-secret-uuid") && !joined.includes("asha@acme.in") && !joined.includes("hunter2"), "logs must not contain tenant id, email or error text");
  const line = JSON.parse(logs.find((l) => l.includes('"/api/v1/documents/:id"') || l.includes("documents/:id"))!);
  assert.equal(line.msg, "http_request"); assert.equal(line.requestId, "req-12345678"); assert.match(line.tenant, /^[0-9a-f]{12}$/);
  const boom = logs.map((l) => JSON.parse(l)).find((l) => l.status === 500);
  assert.equal(boom.level, "error");

  const m = calls.find((c) => c.url === "https://otlp.test/otlp/v1/metrics");
  assert.ok(m, "metrics were exported");
  assert.equal(m.init.headers.Authorization, "Basic abc123");
  assert.equal(m.init.headers["X-Scope"], "mp");
  assert.ok(calls.some((c) => c.url.endsWith("/v1/traces")), "the 500 request was traced");
});

test("an unreachable collector never breaks or slows the API", async () => {
  const realFetch = globalThis.fetch; const real = console.warn; console.warn = () => {};
  globalThis.fetch = (async () => { throw new Error("collector down"); }) as any;
  try {
    registry.lastFlush = 0; emit("x_test");
    const res = await app().request("/api/v1/documents/1", {}, ENV);
    assert.equal(res.status, 200);
    await maybeFlush(registry, ENV, true); // must resolve, not throw
  } finally { globalThis.fetch = realFetch; console.warn = real; }
});

function ingestApp() { const a = new Hono<any>(); a.post("/t", telemetryIngest as any); return a; }
const send = (body: unknown, raw?: string) => ingestApp().request("/t", { method: "POST", body: raw ?? JSON.stringify(body) }, {} as any);

test("RUM ingest: accepts known events, drops unknown names/labels, caps size", async () => {
  const before = registry.hists.size;
  const res = await send({ events: [
    { t: "vital", name: "LCP", v: 1800, view: "dashboard" },
    { t: "feature", view: "gst", v: 90, temp: "warm" },
    { t: "vital", name: "EVIL_METRIC", v: 1 },                 // not in allow-list
    { t: "vital", name: "LCP", v: 9e9 },                         // out of range
    { t: "feature", view: "<script>alert(1)</script>", v: 50 }, // unknown view → "other"
  ] });
  assert.equal(res.status, 204);
  const names = [...registry.hists.values()].map((h) => JSON.stringify(h.attrs));
  assert.ok(names.some((n) => n.includes('"LCP"') && n.includes("dashboard")));
  assert.ok(names.some((n) => n.includes('"view":"gst"') && n.includes("warm")));
  assert.ok(!names.join().includes("EVIL_METRIC") && !names.join().includes("script"));
  assert.ok(registry.hists.size >= before);
  assert.equal((await send(null, "x".repeat(9000))).status, 413);
  assert.equal((await send(null, "{not json")).status, 400);
  assert.equal((await send({ events: "nope" })).status, 400);
});

test("RUM ingest: client error messages are scrubbed before logging", async () => {
  const logs: string[] = []; const real = console.warn; console.warn = (m: any) => logs.push(String(m));
  try { await send({ events: [{ t: "error", kind: "js", view: "billing", msg: "Failed for asha@acme.in at https://app.marginpulse.in/x?token=abcdef order 1234567890" }] }); }
  finally { console.warn = real; }
  const line = logs.find((l) => l.includes("client_error"))!;
  assert.ok(line && !line.includes("asha@acme.in") && !line.includes("https://") && !line.includes("1234567890"));
});
