// In-isolate metrics registry + OTLP/HTTP-JSON exporter.
//
// Workers are stateless and short-lived, so a Prometheus *scrape* endpoint would
// see a random isolate each time. Instead every isolate keeps cumulative counters
// and histograms and PUSHES them (OTLP) to an OpenTelemetry Collector or Grafana
// Cloud, labelled with its own service.instance.id. Dashboards use
// sum by (...)(rate(...)) so isolate churn is invisible.
//
// PRIVACY: attribute values are restricted to short enum-like tokens (see
// safeLabel). Emails, tenant ids, names and amounts never enter a metric.

export type Attrs = Record<string, string>;

export const BOUNDS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export const BOUNDS_MS = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800];

const LABEL_RE = /^[a-z0-9_.:\-\/]{1,64}$/i;
export const safeLabel = (v: unknown, fallback = "other"): string => (typeof v === "string" && LABEL_RE.test(v) ? v : fallback);

interface Counter { name: string; attrs: Attrs; value: number }
interface Hist { name: string; unit: string; bounds: number[]; attrs: Attrs; count: number; sum: number; buckets: number[] }

// Labels Prometheus reserves (target labels `job`/`instance`, histogram `le`, summary `quantile`, internal `__*`). The collector's
// Prometheus exporter rejects the WHOLE metric when a datapoint attribute collides with one ("duplicate label names in constant and
// variable labels"), silently losing it — so they are renamed at the source instead of trusting every caller to remember.
const RESERVED_LABELS = new Set(["job", "instance", "le", "quantile"]);
export const sanitizeAttrs = (a: Attrs): Attrs => {
  let out: Attrs | undefined;
  for (const k of Object.keys(a)) {
    if (RESERVED_LABELS.has(k) || k.startsWith("__")) { out ??= { ...a }; delete out[k]; out[`${k.replace(/^_+/, "")}_attr`] = a[k]!; }
  }
  return out ?? a;
};

const attrKey = (name: string, a: Attrs) => name + "|" + Object.keys(a).sort().map((k) => `${k}=${a[k]}`).join(",");

export class Registry {
  // Workers forbid random values in GLOBAL scope (this object is created at module load, and
  // `crypto.randomUUID()` there makes the Worker fail to start: "Disallowed operation called within
  // global scope"). So both are created lazily, on first use inside a request handler.
  private _id: string | undefined;
  private _start: bigint | undefined;
  get instanceId(): string { return (this._id ??= crypto.randomUUID()); }
  get startNs(): bigint { return (this._start ??= BigInt(Date.now()) * 1_000_000n); }
  counters = new Map<string, Counter>();
  hists = new Map<string, Hist>();
  spans: Span[] = [];
  lastFlush = 0; // a fresh isolate exports as soon as it has something to say
  dirty = 0;

  inc(name: string, attrs: Attrs = {}, by = 1): void {
    attrs = sanitizeAttrs(attrs);
    const k = attrKey(name, attrs);
    const c = this.counters.get(k);
    if (c) c.value += by; else this.counters.set(k, { name, attrs, value: by });
    void this.startNs;
    this.dirty++;
  }

  observe(name: string, unit: "s" | "ms", value: number, attrs: Attrs = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    attrs = sanitizeAttrs(attrs);
    const bounds = unit === "s" ? BOUNDS_SECONDS : BOUNDS_MS;
    const k = attrKey(name, attrs);
    let h = this.hists.get(k);
    if (!h) { h = { name, unit, bounds, attrs, count: 0, sum: 0, buckets: new Array(bounds.length + 1).fill(0) }; this.hists.set(k, h); }
    let i = 0;
    while (i < bounds.length && value > bounds[i]!) i++;
    h.buckets[i]!++; h.count++; h.sum += value;
    void this.startNs;
    this.dirty++;
  }

  addSpan(s: Span): void { if (this.spans.length < 200) this.spans.push(s); }
}

export interface Span { traceId: string; spanId: string; name: string; startMs: number; endMs: number; attrs: Record<string, string | number | boolean>; error: boolean }

const attrList = (a: Record<string, string | number | boolean>) =>
  Object.entries(a).map(([key, v]) => ({ key, value: typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v) } }));

function resource(reg: Registry, environment: string) {
  return { attributes: attrList({ "service.name": "marginpulse-api", "service.instance.id": reg.instanceId, "deployment.environment": environment, "telemetry.sdk.name": "marginpulse-worker" }) };
}

export function buildMetricsPayload(reg: Registry, environment: string, nowMs = Date.now()) {
  const t = String(BigInt(nowMs) * 1_000_000n);
  const start = String(reg.startNs);
  const metrics: unknown[] = [];
  const byName = new Map<string, Hist[]>();
  for (const h of reg.hists.values()) (byName.get(h.name) ?? byName.set(h.name, []).get(h.name)!).push(h);
  for (const [name, list] of byName) {
    metrics.push({
      name, unit: list[0]!.unit,
      histogram: { aggregationTemporality: 2, dataPoints: list.map((h) => ({ attributes: attrList(h.attrs), startTimeUnixNano: start, timeUnixNano: t, count: String(h.count), sum: h.sum, bucketCounts: h.buckets.map(String), explicitBounds: h.bounds })) },
    });
  }
  const cByName = new Map<string, Counter[]>();
  for (const c of reg.counters.values()) (cByName.get(c.name) ?? cByName.set(c.name, []).get(c.name)!).push(c);
  for (const [name, list] of cByName) {
    metrics.push({ name, unit: "{event}", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: list.map((c) => ({ attributes: attrList(c.attrs), startTimeUnixNano: start, timeUnixNano: t, asInt: String(c.value) })) } });
  }
  return { resourceMetrics: [{ resource: resource(reg, environment), scopeMetrics: [{ scope: { name: "marginpulse.telemetry", version: "1" }, metrics }] }] };
}

export function buildTracesPayload(reg: Registry, environment: string, spans: Span[]) {
  return {
    resourceSpans: [{
      resource: resource(reg, environment),
      scopeSpans: [{ scope: { name: "marginpulse.telemetry", version: "1" }, spans: spans.map((s) => ({
        traceId: s.traceId, spanId: s.spanId, name: s.name, kind: 2,
        startTimeUnixNano: String(BigInt(Math.round(s.startMs)) * 1_000_000n), endTimeUnixNano: String(BigInt(Math.round(s.endMs)) * 1_000_000n),
        attributes: attrList(s.attrs), status: { code: s.error ? 2 : 1 },
      })) }],
    }],
  };
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface ExportEnv { OTLP_ENDPOINT?: string; OTLP_HEADERS?: string; ENVIRONMENT?: string }

const MIN_FLUSH_MS = 10_000;
const MIN_EVENTS = 100;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_SPANS = 200;
let flushing = false;
let failures = 0;          // consecutive failed exports
let nextAttemptAt = 0;     // don't hammer a dead collector: exponential backoff 10 s, 20 s, 40 s … capped at 5 min
export const resetFlushStateForTests = () => { flushing = false; failures = 0; nextAttemptAt = 0; };

/**
 * Fire-and-forget; never throws, never blocks a response. Call inside ctx.waitUntil.
 * Counters/histograms are CUMULATIVE, so a failed export loses nothing — the next successful one carries the totals.
 * Spans are not cumulative, so on failure they are put back (bounded) and re-sent with the next attempt.
 */
export async function maybeFlush(reg: Registry, env: ExportEnv, force = false): Promise<void> {
  const endpoint = env.OTLP_ENDPOINT?.replace(/\/+$/, "");
  if (!endpoint || flushing) return;
  const now = Date.now();
  if (!force) {
    if (now < nextAttemptAt) return;
    const due = now - reg.lastFlush >= MIN_FLUSH_MS || reg.dirty >= MIN_EVENTS;
    if (!(due && (reg.dirty > 0 || reg.spans.length > 0))) return;
  }
  flushing = true;
  const spans = reg.spans.splice(0, reg.spans.length);
  reg.lastFlush = now;
  reg.dirty = 0;
  const headers = { "Content-Type": "application/json", ...parseHeaders(env.OTLP_HEADERS) };
  const environment = env.ENVIRONMENT ?? "production";
  let metricsOk = false, tracesOk = true;
  try {
    const sends = [fetch(`${endpoint}/v1/metrics`, { method: "POST", headers, body: JSON.stringify(buildMetricsPayload(reg, environment)), signal: AbortSignal.timeout(4000) })];
    if (spans.length) sends.push(fetch(`${endpoint}/v1/traces`, { method: "POST", headers, body: JSON.stringify(buildTracesPayload(reg, environment, spans)), signal: AbortSignal.timeout(4000) }));
    const res = await Promise.allSettled(sends);
    const good = (r: PromiseSettledResult<Response>) => r.status === "fulfilled" && r.value.ok;
    metricsOk = good(res[0]!);
    if (spans.length) tracesOk = good(res[1]!);
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "otlp_export_error", error: (e as Error).message }));
  } finally {
    if (!tracesOk) { reg.spans.unshift(...spans); if (reg.spans.length > MAX_SPANS) reg.spans.splice(0, reg.spans.length - MAX_SPANS); } // keep the newest
    if (metricsOk && tracesOk) { failures = 0; nextAttemptAt = 0; }
    else {
      failures++; nextAttemptAt = Date.now() + Math.min(MAX_BACKOFF_MS, 10_000 * 2 ** (failures - 1));
      reg.dirty = Math.max(reg.dirty, 1); // something is still unsent
      console.warn(JSON.stringify({ level: "warn", msg: "otlp_export_failed", metricsOk, tracesOk, consecutiveFailures: failures, retryInMs: nextAttemptAt - Date.now() }));
    }
    flushing = false;
  }
}

/** End-of-invocation flush for queue/cron isolates (no HTTP middleware runs there). At most one forced export per 2 s, and it honours the failure backoff. */
export function flushPending(reg: Registry, env: ExportEnv): Promise<void> {
  const now = Date.now();
  return maybeFlush(reg, env, (reg.dirty > 0 || reg.spans.length > 0) && now - reg.lastFlush >= 2000 && now >= nextAttemptAt);
}
