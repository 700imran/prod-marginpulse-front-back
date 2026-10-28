// Cloudflare Turnstile server-side verification.
//
// The browser widget only produces a token; a token proves nothing until the SERVER asks
// Cloudflare to validate it with the secret key. We also pin hostname and action so a token
// minted on another site/form can't be replayed here, and cap its length before any network call.
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../config";
import { emit } from "../observability/events";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_HEADER = "X-Turnstile-Token";
const MAX_TOKEN_LEN = 2048;

export type CaptchaResult = { ok: true } | { ok: false; status: 400 | 403 | 503; error: string; codes?: string[] };

interface SiteverifyResponse { success: boolean; hostname?: string; action?: string; "error-codes"?: string[] }

export function captchaConfigured(env: Pick<Env, "TURNSTILE_SECRET" | "TURNSTILE_SITE_KEY">): boolean {
  return Boolean(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY);
}

export async function verifyTurnstile(
  env: Pick<Env, "TURNSTILE_SECRET" | "FRONTEND_ORIGIN">,
  token: string | undefined | null,
  opts: { action: string; remoteIp?: string },
): Promise<CaptchaResult> {
  if (!token) return { ok: false, status: 403, error: "Security check required" };
  if (token.length > MAX_TOKEN_LEN) return { ok: false, status: 400, error: "Invalid security check token" };
  if (!env.TURNSTILE_SECRET) return { ok: false, status: 503, error: "Security check unavailable" };

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (opts.remoteIp) body.set("remoteip", opts.remoteIp);
  body.set("idempotency_key", crypto.randomUUID());

  let data: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, status: 503, error: "Security check unavailable" };
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    // Cloudflare unreachable: fail CLOSED — an outage must not turn the protection off.
    return { ok: false, status: 503, error: "Security check unavailable" };
  }
  if (!data.success) return { ok: false, status: 403, error: "Security check failed", codes: data["error-codes"] };

  const allowedHost = (() => { try { return new URL(env.FRONTEND_ORIGIN).hostname; } catch { return ""; } })();
  if (allowedHost && data.hostname && data.hostname !== allowedHost) return { ok: false, status: 403, error: "Security check failed", codes: ["hostname-mismatch"] };
  if (data.action && data.action !== opts.action) return { ok: false, status: 403, error: "Security check failed", codes: ["action-mismatch"] };
  return { ok: true };
}

/**
 * Route guard. Token comes in the X-Turnstile-Token header (so the body stays untouched).
 * If Turnstile isn't configured yet the guard lets traffic through but records it, so enabling
 * the feature is a pure config change and an un-configured deploy never locks users out.
 */
export function requireCaptcha(action: string, opts: { skipIf?: (c: Context<{ Bindings: Env }>) => Promise<boolean> | boolean } = {}): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!captchaConfigured(c.env)) { emit("captcha", { outcome: "skipped_unconfigured", action }); return next(); }
    if (opts.skipIf && (await opts.skipIf(c))) { emit("captcha", { outcome: "skipped_authenticated", action }); return next(); }
    const r = await verifyTurnstile(c.env, c.req.header(TURNSTILE_HEADER), { action, remoteIp: c.req.header("CF-Connecting-IP") });
    if (!r.ok) {
      emit("captcha", { outcome: r.status === 503 ? "unavailable" : "rejected", action });
      return c.json({ error: r.error, captcha: true }, r.status);
    }
    emit("captcha", { outcome: "passed", action });
    return next();
  };
}
