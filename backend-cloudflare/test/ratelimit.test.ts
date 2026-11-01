// A stalled Redis must never freeze a request (this sits in front of the Pay button).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { rateLimit } from "../src/middleware/rateLimit.ts";
import { registry } from "../src/observability/events.ts";

const ENV: any = { UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "t" };
const real = globalThis.fetch;
// AbortSignal.timeout() timers are unref'd in Node (not in Workers); keep the loop alive so the test can observe them.
let keep: any; const alive = () => { keep = setTimeout(() => {}, 8000); }; const done = () => clearTimeout(keep);
const hang = () => (globalThis.fetch = ((_u: any, init: any) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as any);
const app = (opts?: any) => { const a = new Hono<any>(); a.use("*", rateLimit("billing", 30, 60, opts)); a.post("/x", (c) => c.json({ ok: true })); return a; };

test("Redis hangs: billing request still goes through, within ~2 s (fail-open), and the outage is counted", async () => {
  hang(); alive();
  const before = [...registry.counters.values()].find((c) => c.attrs.event === "ratelimit_backend_error")?.value ?? 0;
  const t0 = Date.now();
  try {
    const r = await app().request("/x", { method: "POST" }, ENV);
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(ms < 3500, `took ${ms} ms`);
  } finally { globalThis.fetch = real; done(); }
  const after = [...registry.counters.values()].find((c) => c.attrs.event === "ratelimit_backend_error")!.value;
  assert.equal(after, before + 1);
});

test("Redis hangs with failClosed: answers 503 quickly instead of hanging", async () => {
  hang(); alive();
  const t0 = Date.now();
  try {
    const r = await app({ failClosed: true }).request("/x", { method: "POST" }, ENV);
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t0 < 3500);
  } finally { globalThis.fetch = real; done(); }
});

test("limiter still blocks when Redis says the quota is used up", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: 31 }))) as any;
  try { assert.equal((await app().request("/x", { method: "POST" }, ENV)).status, 429); } finally { globalThis.fetch = real; }
});

test("separate isolate limiters do not share one counter (a busy user must not be 429'd on billing by unrelated traffic)", async () => {
  const { isolateRateLimit } = await import("../src/middleware/rateLimit.ts");
  const a = new Hono<any>();
  a.use("/api/*", isolateRateLimit(600, 60));
  a.use("/api/billing/*", isolateRateLimit(30, 60));
  a.get("/api/other", (c) => c.json({}));
  a.get("/api/billing/x", (c) => c.json({}));
  const h = { "CF-Connecting-IP": "203.0.113.77" };
  for (let i = 0; i < 100; i++) await a.request("/api/other", { headers: h });   // heavy unrelated traffic
  assert.equal((await a.request("/api/billing/x", { headers: h })).status, 200);
});
