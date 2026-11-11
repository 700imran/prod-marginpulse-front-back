// Provider outages must never hang a request, wedge a queue, or mark a record FAILED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchExternal, ExternalCallError, isRetryableStatus } from "../src/lib/external.ts";
import { verifyGSTIN, verifyPAN, verifyBankAccount } from "../src/pipelines/identity.ts";
import { TASK_REGISTRY, TransientTaskError, handleQueueBatch } from "../src/queue/consumer.ts";

const real = globalThis.fetch;
let keep: any; const alive = () => { keep = setInterval(() => {}, 1000); }; const done = () => clearInterval(keep);
const hang = () => (globalThis.fetch = ((_u: any, init: any) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))))) as any);
const respond = (status: number, body: unknown = {}) => (globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as any);
const ENV: any = { GST_API_CLIENT_ID: "id", GST_API_CLIENT_SECRET: "s", GST_API_BASE_URL: "https://gst.test" };

test("fetchExternal: a hung provider is cut off at the deadline with a typed error", async () => {
  hang(); alive();
  const t0 = Date.now();
  try { await assert.rejects(fetchExternal("gst", "https://x.test", {}, 200), (e: any) => e instanceof ExternalCallError && e.kind === "timeout" && e.provider === "gst"); }
  finally { globalThis.fetch = real; done(); }
  assert.ok(Date.now() - t0 < 1500);
});

test("isRetryableStatus: 429 and 5xx retry; 400/401/404 do not", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [200, 400, 401, 403, 404, 422]) assert.equal(isRetryableStatus(s), false, String(s));
});

test("identity: timeout / 429 / 5xx → PENDING + transient (never FAILED); real rejection → FAILED", async () => {
  try {
    for (const verify of [(e: any) => verifyGSTIN(e, "27AAACA1234F1Z5"), (e: any) => verifyPAN(e, "AAACA1234F"), (e: any) => verifyBankAccount(e, "123456789", "HDFC0001234", "Acme")]) {
      for (const status of [429, 500, 503]) { respond(status); const r = await verify(ENV); assert.equal(r.status, "PENDING"); assert.equal(r.transient, true, `HTTP ${status}`); }
      globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as any;
      const net = await verify(ENV); assert.equal(net.status, "PENDING"); assert.equal(net.transient, true);
      respond(404); const rej = await verify(ENV); assert.equal(rej.status, "FAILED"); assert.ok(!rej.transient);
    }
    respond(200, { lgnm: "ACME", sts: "Active" }); assert.equal((await verifyGSTIN(ENV, "27AAACA1234F1Z5")).status, "VERIFIED");
    respond(200, { lgnm: "ACME", sts: "Cancelled" }); assert.equal((await verifyGSTIN(ENV, "27AAACA1234F1Z5")).status, "FAILED");
  } finally { globalThis.fetch = real; }
});

type Fake = { body: any; attempts: number; acked: boolean; retried: { delaySeconds?: number } | null; ack(): void; retry(o?: any): void };
const msg = (task: string, attempts = 1): Fake => ({ body: { task, job_id: "j", args: {} }, attempts, acked: false, retried: null, ack() { this.acked = true; }, retry(o) { this.retried = o ?? {}; } });

test("queue: transient failure retries with exponential backoff, then gives up after 6 attempts without losing the record", async () => {
  TASK_REGISTRY.__t = async () => { throw new TransientTaskError("provider down"); };
  const m1 = msg("__t", 1), m3 = msg("__t", 3), m6 = msg("__t", 6);
  await handleQueueBatch({ messages: [m1, m3, m6] } as any, {} as any);
  assert.equal(m1.retried?.delaySeconds, 10);
  assert.equal(m3.retried?.delaySeconds, 40);
  assert.equal(m6.acked, true); assert.equal(m6.retried, null);
  delete TASK_REGISTRY.__t;
});

test("queue: a hung message does not block the rest of the batch (concurrent, allSettled)", async () => {
  alive();
  TASK_REGISTRY.__slow = () => new Promise<void>((r) => setTimeout(r, 600));
  TASK_REGISTRY.__fast = async () => {};
  TASK_REGISTRY.__boom = async () => { throw new Error("bug"); };
  const slow = msg("__slow"), fast = msg("__fast"), boom = msg("__boom");
  const t0 = Date.now();
  await handleQueueBatch({ messages: [slow, boom, fast] } as any, {} as any);
  done();
  assert.ok(Date.now() - t0 < 1200, "batch must take ~max(task), not sum(task)");
  assert.ok(slow.acked && fast.acked);
  assert.ok(boom.retried, "a real error is retried (and lands in the DLQ after max_retries)");
  for (const k of ["__slow", "__fast", "__boom"]) delete TASK_REGISTRY[k];
});

test("queue: unknown task is dropped, not retried forever", async () => {
  const m = msg("nope"); await handleQueueBatch({ messages: [m] } as any, {} as any);
  assert.ok(m.acked && !m.retried);
});
