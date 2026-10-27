import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../config";

export const requestId: MiddlewareHandler = async (c, next) => {
  // Accept a caller-supplied id only if it is a sane token (log-injection safe).
  const incoming = c.req.header("X-Request-Id") ?? "";
  const id = /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
};

// This is a JSON API: it never needs to load scripts, frames or images, so the
// CSP is the strictest possible and any HTML that ever leaks out is inert.
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  c.header("Cross-Origin-Resource-Policy", "same-site");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("X-Permitted-Cross-Domain-Policies", "none");
  // Authenticated financial data must never sit in a shared/browser cache.
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  c.res.headers.delete("Server");
  c.res.headers.delete("X-Powered-By");
};

// FRONTEND_ORIGIN may hold several comma-separated origins. The request's
// Origin is reflected ONLY when it is on the list (never "*" with credentials).
export function allowedOrigins(env: Pick<Env, "FRONTEND_ORIGIN">): string[] {
  return (env.FRONTEND_ORIGIN ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
}

// First configured origin — used when the API must build a link/redirect back to the app.
export function primaryOrigin(env: Pick<Env, "FRONTEND_ORIGIN">): string {
  return allowedOrigins(env)[0] ?? "";
}

export function corsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    c.header("Vary", "Origin");
    if (origin && allowedOrigins(c.env).includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-Id");
      c.header("Access-Control-Expose-Headers", "X-Request-Id,X-RateLimit-Remaining,Retry-After");
      c.header("Access-Control-Max-Age", "600");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  };
}

// Request-size ceilings (checked on Content-Length AND while streaming, so a
// lying/chunked client can't bypass them): small for JSON, larger for uploads.
const ceilingFor = (path: string): number =>
  path.endsWith("/documents/upload") ? 16 * 1024 * 1024
  : path.endsWith("/reconciliation/dataset-upload") ? 12 * 1024 * 1024
  : path.startsWith("/webhook") || path.startsWith("/api/razorpay") ? 1024 * 1024
  : 256 * 1024;

export const requestSizeLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  return bodyLimit({
    maxSize: ceilingFor(c.req.path),
    onError: (ctx) => ctx.json({ error: "request body too large" }, 413),
  })(c, next);
};
