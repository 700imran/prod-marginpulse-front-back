// Dependency-free home of the registry and emit(): every layer (auth, rate limiting,
// billing, ...) can import this without creating import cycles.
import type { Env } from "../config";
import { Registry, safeLabel, type Attrs } from "./metrics";

// One registry per isolate (module scope). See metrics.ts for why we push, not scrape.
export const registry = new Registry();
let sink: Partial<Env> = {};
export const setSink = (env: Partial<Env>) => { sink = env; };

/** Business / security event counter, e.g. emit("payment", { outcome: "verified" }). */
export function emit(event: string, attrs: Attrs = {}, by = 1): void {
  const clean: Attrs = { event: safeLabel(event) };
  for (const [k, v] of Object.entries(attrs)) clean[safeLabel(k)] = safeLabel(v);
  registry.inc("marginpulse.events", clean, by);
  try { sink.METRICS?.writeDataPoint({ indexes: [clean.event!], blobs: [attrs.outcome ?? attrs.limiter ?? attrs.reason ?? ""], doubles: [by] }); } catch { /* telemetry must never break a request */ }
}
