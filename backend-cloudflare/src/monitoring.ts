// Error/event reporting for everything this Worker can't surface to an
// end user directly: unhandled exceptions, queue tasks that exhausted
// their retries, scheduled-sweep failures, dependency outages.
//
// Two sinks, one always on:
//   1. Structured console output — always runs, regardless of
//      configuration. This is what Cloudflare Workers Logs captures,
//      and what the free dashboards described in MONITORING.md are
//      built from. This sink cannot silently fail to report something:
//      if the Worker ran this line, the log line exists.
//   2. Sentry, only if SENTRY_DSN is set. Optional, additive, and NOT
//      independently verified end-to-end — see the warning below.
//
// VERIFICATION NOTE: the Sentry call here follows Sentry's documented
// legacy Store API (https://develop.sentry.dev/sdk/store/) by hand, with
// no npm dependency. There is no live Sentry project in the environment
// this was written in to send a real event to and confirm delivery.
// Before relying on this, set a real SENTRY_DSN, trigger a test error
// (MONITORING.md has a one-line way to do that), and confirm it
// actually appears in your Sentry project. If the auth header or
// payload shape is ever slightly off, Sentry will just silently drop
// the event — nothing in this file will tell you that happened; the
// dashboard staying empty is the only signal. Sink 1 above is the one
// guaranteed-correct source of truth regardless.
import type { Env } from "./config";

export type Severity = "fatal" | "error" | "warning" | "info";

export interface ReportOptions {
  message?: string;
  severity?: Severity;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

function parseDsn(dsn: string): { host: string; projectId: string; publicKey: string } | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, "");
    if (!publicKey || !projectId) return null;
    return { host: url.host, projectId, publicKey };
  } catch {
    return null;
  }
}

// Fire-and-forget by design, but still returns a Promise so callers with
// access to an ExecutionContext can keep the Worker alive long enough
// for the Sentry request to actually complete:
//   ctx.waitUntil(reportError(env, err, { tags: { area: "queue" } }));
// Safe to not await/waitUntil at all — the console sink is synchronous
// and already done by the time this function returns; only the optional
// Sentry POST benefits from waitUntil.
export async function reportError(env: Env, err: unknown, opts: ReportOptions = {}): Promise<void> {
  const severity = opts.severity ?? "error";
  const message = opts.message ?? (err instanceof Error ? err.message : String(err));
  const stack = err instanceof Error ? err.stack : undefined;

  const log = severity === "fatal" || severity === "error" ? console.error : severity === "warning" ? console.warn : console.log;
  log("monitoring_event", { message, severity, tags: opts.tags, extra: opts.extra, stack });

  if (!env.SENTRY_DSN) return;
  const dsn = parseDsn(env.SENTRY_DSN);
  if (!dsn) {
    console.error("monitoring_sentry_dsn_invalid", { reason: "SENTRY_DSN is set but could not be parsed as a URL" });
    return;
  }

  const body = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    level: severity,
    message: { message },
    exception:
      err instanceof Error
        ? { values: [{ type: err.name || "Error", value: err.message }] }
        : undefined,
    tags: opts.tags,
    extra: { ...opts.extra, stack },
    platform: "javascript",
    environment: env.ENVIRONMENT,
    server_name: "marginpulse-cloudflare-worker",
  };

  try {
    const res = await fetch(`https://${dsn.host}/api/${dsn.projectId}/store/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=marginpulse-custom/1.0`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("monitoring_sentry_send_rejected", { status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) });
    }
  } catch (e) {
    console.error("monitoring_sentry_send_failed", { error: (e as Error).message });
  }
}
