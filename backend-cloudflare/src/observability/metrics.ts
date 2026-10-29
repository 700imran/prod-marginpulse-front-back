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
  lastFlush = Date.now();
  dirty = 0;

  inc(name: string, attrs: Attrs = {}, by = 1): void {
    const k = attrKey(name, attrs);
    const c = this.counters.get(k);
    if (c) c.value += by; else this.counters.set(k, { name, attrs, value: by });
    void this.startNs;
    this.dirty++;
  }

  observe(name: string, unit: "s" | "ms", value: number, attrs: Attrs = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
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
let flushing = false;

/** Fire-and-forget; never throws, never blocks a response. Call inside ctx.waitUntil. */
export async function maybeFlush(reg: Registry, env: ExportEnv, force = false): Promise<void> {
  const endpoint = env.OTLP_ENDPOINT?.replace(/\/+$/, "");
  if (!endpoint || flushing) return;
  const due = Date.now() - reg.lastFlush >= MIN_FLUSH_MS || reg.dirty >= MIN_EVENTS;
  if (!force && !(due && (reg.dirty > 0 || reg.spans.length > 0))) return;
  flushing = true;
  const spans = reg.spans.splice(0, reg.spans.length);
  reg.lastFlush = Date.now();
  reg.dirty = 0;
  const headers = { "Content-Type": "application/json", ...parseHeaders(env.OTLP_HEADERS) };
  const environment = env.ENVIRONMENT ?? "production";
  try {
    const sends = [fetch(`${endpoint}/v1/metrics`, { method: "POST", headers, body: JSON.stringify(buildMetricsPayload(reg, environment)), signal: AbortSignal.timeout(4000) })];
    if (spans.length) sends.push(fetch(`${endpoint}/v1/traces`, { method: "POST", headers, body: JSON.stringify(buildTracesPayload(reg, environment, spans)), signal: AbortSignal.timeout(4000) }));
    const res = await Promise.allSettled(sends);
    const failed = res.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
    if (failed) console.warn(JSON.stringify({ level: "warn", msg: "otlp_export_failed", failed }));
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "otlp_export_error", error: (e as Error).message }));
  } finally {
    flushing = false;
  }
}
