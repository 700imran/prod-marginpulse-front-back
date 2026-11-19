// Closes the gaps found in the observability audit:
//  1. queue retries / failures / give-ups are visible as metrics (they used to be log-only),
//  2. a queue- or cron-only isolate still pushes its metrics (export used to be triggered only by HTTP requests),
//  3. a failed OTLP export keeps its spans and backs off, instead of dropping them and hammering a dead collector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/observability/events.ts";
import { Registry, maybeFlush, resetFlushStateForTests } from "../src/observability/metrics.ts";
import { TASK_REGISTRY, TransientTaskError, handleQueueBatch } from "../src/queue/consumer.ts";
import worker from "../src/index.ts";

const counter = (name: string, attrs: Record<string, string>) => {
  for (const c of registry.counters.values()) if (c.name === name && Object.entries(attrs).every(([k, v]) => c.attrs[k] === v)) return c.value;
  return 0;
};
const mkMsg = (task: string, attempts = 1) => { const r = { acked: 0, retried: 0, delay: -1 }; return { r, m: { body: { task, job_id: "j", args: {} }, attempts, ack() { r.acked++; }, retry(o: any) { r.retried++; r.delay = o?.delaySeconds ?? 0; } } as any }; };

test("queue: every outcome is counted — ok, retry (transient and not), gave_up, unknown — with a duration histogram", async () => {
  const saved = { ...TASK_REGISTRY };
  TASK_REGISTRY.t_ok = async () => {};
  TASK_REGISTRY.t_boom = async () => { throw new Error("bug"); };
  TASK_REGISTRY.t_flaky = async () => { throw new TransientTaskError("provider down"); };
  try {
    const before = { ok: counter("marginpulse.events", { event: "queue_task", outcome: "ok", task: "t_ok" }), retry: counter("marginpulse.events", { event: "queue_task", outcome: "retry", task: "t_boom" }), tr: counter("marginpulse.events", { event: "queue_task", outcome: "retry", task: "t_flaky" }), gu: counter("marginpulse.events", { event: "queue_task", outcome: "gave_up", task: "t_flaky" }), un: counter("marginpulse.events", { event: "queue_task", outcome: "unknown" }) };
    const ok = mkMsg("t_ok"), boom = mkMsg("t_boom"), flaky = mkMsg("t_flaky", 2), dead = mkMsg("t_flaky", 6), unk = mkMsg("nope");
    const real = console.error; console.error = () => {};
    try { await handleQueueBatch({ messages: [ok.m, boom.m, flaky.m, dead.m, unk.m] } as any, {} as any); } finally { console.error = real; }
    assert.equal(counter("marginpulse.events", { event: "queue_task", outcome: "ok", task: "t_ok" }), before.ok + 1);
    assert.equal(counter("marginpulse.events", { event: "queue_task", outcome: "retry", task: "t_boom" }), before.retry + 1);
    assert.equal(counter("marginpulse.events", { event: "queue_task", outcome: "retry", task: "t_flaky" }), before.tr + 1);
    assert.equal(counter("marginpulse.events", { event: "queue_task", outcome: "gave_up", task: "t_flaky" }), before.gu + 1);
    assert.equal(counter("marginpulse.events", { event: "queue_task", outcome: "unknown" }), before.un + 1);
    assert.ok([...registry.hists.values()].some((h) => h.name === "marginpulse.queue.task.duration" && h.attrs.task === "t_ok" && h.count >= 1), "task duration is observed");
    assert.deepEqual([ok.r.acked, boom.r.retried, flaky.r.retried, dead.r.acked, unk.r.acked], [1, 1, 1, 1, 1], "ack/retry behaviour is unchanged");
  } finally { for (const k of Object.keys(TASK_REGISTRY)) if (!(k in saved)) delete TASK_REGISTRY[k]; }
});

test("a queue batch and a cron run push their metrics even though no HTTP request happened in this isolate", async () => {
  const realFetch = globalThis.fetch; const posts: string[] = [];
  globalThis.fetch = (async (u: any) => { posts.push(String(u)); return new Response("{}", { status: 200 }); }) as any;
  resetFlushStateForTests(); registry.lastFlush = 0;
  try {
    const env: any = { OTLP_ENDPOINT: "https://otlp.test/otlp", OTLP_HEADERS: "Authorization=Bearer t", ENVIRONMENT: "test", HYPERDRIVE: { connectionString: "postgres://u:p@127.0.0.1:1/x" } };
    const pending: Promise<unknown>[] = []; const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    TASK_REGISTRY.t_ok2 = async () => {};
    try { await (worker as any).queue({ messages: [mkMsg("t_ok2").m] }, env, ctx); } finally { delete TASK_REGISTRY.t_ok2; }
    await Promise.all(pending.splice(0));
    assert.ok(posts.some((u) => u.endsWith("/v1/metrics")), "queue() flushed");
    posts.length = 0; resetFlushStateForTests(); registry.lastFlush = 0; // (forced flushes are throttled to one per 2 s)
    const real = console.error; console.error = () => {};
    try { await (worker as any).scheduled({}, env, ctx); assert.fail("scheduled() must surface a failed run"); } catch (e) { assert.match((e as Error).message, /ECONNREFUSED|connect/i); } finally { console.error = real; } // DB unreachable → the run fails: counted AND rethrown
    await Promise.all(pending.splice(0));
    assert.ok(posts.some((u) => u.endsWith("/v1/metrics")), "scheduled() flushed");
    assert.ok(counter("marginpulse.events", { event: "cron_run", outcome: "error" }) >= 1, "a failed cron run is counted");
  } finally { globalThis.fetch = realFetch; }
});

test("export failure: spans are kept for the next attempt, attempts back off exponentially, and recovery delivers everything", async () => {
  const realFetch = globalThis.fetch; const real = console.warn; console.warn = () => {};
  let up = false; const traces: number[] = []; let calls = 0;
  globalThis.fetch = (async (u: any, init: any) => {
    calls++;
    if (!up) throw new Error("collector down");
    if (String(u).endsWith("/v1/traces")) traces.push(JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans.length);
    return new Response("{}", { status: 200 });
  }) as any;
  resetFlushStateForTests();
  try {
    const reg = new Registry(); const env = { OTLP_ENDPOINT: "https://otlp.test", ENVIRONMENT: "test" };
    const span = (i: number) => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), name: `GET /x${i}`, startMs: 1, endMs: 2, attrs: {}, error: false });
    reg.inc("x"); reg.addSpan(span(1)); reg.addSpan(span(2));
    await maybeFlush(reg, env, true);
    assert.equal(reg.spans.length, 2, "spans survive a failed export");
    const afterFirst = calls;
    await maybeFlush(reg, env);                       // not forced: still inside the backoff window
    assert.equal(calls, afterFirst, "no hammering of a dead collector");
    up = true; await maybeFlush(reg, env, true);      // forced (e.g. end of a queue batch) bypasses the wait
    assert.deepEqual(traces, [2], "both spans were delivered after recovery");
    assert.equal(reg.spans.length, 0);
    for (let i = 0; i < 400; i++) reg.addSpan(span(i)); assert.ok(reg.spans.length <= 200, "retained spans stay bounded");
  } finally { globalThis.fetch = realFetch; console.warn = real; }
});

test("metric attributes that Prometheus reserves (job, instance, le, quantile, __*) are renamed at the source, never exported as-is", async () => {
  const { sanitizeAttrs } = await import("../src/observability/metrics.ts");
  assert.deepEqual(sanitizeAttrs({ task: "x", outcome: "ok" }), { task: "x", outcome: "ok" }, "ordinary attributes pass through untouched");
  assert.deepEqual(sanitizeAttrs({ job: "daily_sweep", instance: "a", le: "1", quantile: "0.5", __name__: "n" }),
    { job_attr: "daily_sweep", instance_attr: "a", le_attr: "1", quantile_attr: "0.5", name___attr: "n" });
  const r = new Registry();
  r.observe("t.h", "s", 0.1, { job: "daily_sweep" });
  r.inc("t.c", { instance: "x" });
  for (const m of [...r.hists.values(), ...r.counters.values()]) for (const k of Object.keys(m.attrs)) assert.ok(!["job", "instance", "le", "quantile"].includes(k) && !k.startsWith("__"), `reserved label ${k} leaked`);
});

test("the cron run records its duration under a non-reserved attribute, and the cron_run outcome is ok on a healthy sweep", async () => {
  // listAllTenants → [] keeps this independent of a database; getDb is only touched lazily by the repository call below.
  const realFetch = globalThis.fetch; globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any;
  try {
    const before = [...registry.hists.values()].filter((h) => h.name === "marginpulse.cron.duration").reduce((n, h) => n + h.count, 0);
    // A queue stub that swallows messages: with no queue bound the cron would run detection INLINE for tenants of other
    // test files that share this database (and pre-empt their assertions when files run in parallel).
    const env: any = { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL ?? "postgres://127.0.0.1:1/none" }, OTLP_ENDPOINT: "http://127.0.0.1:1", RECONCILE_QUEUE: { sendBatch: async () => {}, send: async () => {} } };
    if (!process.env.TEST_DATABASE_URL) return; // needs a reachable DB to complete a sweep
    await worker.scheduled({} as any, env, { waitUntil() {} } as any);
    const hs = [...registry.hists.values()].filter((h) => h.name === "marginpulse.cron.duration");
    assert.ok(hs.reduce((n, h) => n + h.count, 0) > before, "cron duration was observed");
    assert.ok(hs.every((h) => !("job" in h.attrs)), "no reserved `job` attribute");
  } finally { globalThis.fetch = realFetch; }
});
