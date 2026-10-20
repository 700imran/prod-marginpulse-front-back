import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";

// Replaces middleware.go's RequestID + SecurityHeaders + CORS.

export const requestId: MiddlewareHandler = async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  // This is a JSON API with no HTML/JS/CSS of its own to allow — deny
  // everything by default. Mainly a backstop against a browser somehow
  // rendering a response body as HTML (a misconfigured proxy, a
  // navigated-to error page) rather than something this API relies on
  // day-to-day, but it's a one-line addition with no downside here.
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // No route on this API needs any of these; disable them all rather
  // than inherit whatever a browser's default policy happens to be.
  c.header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
};

// Origins allowed to call this API from a browser: FRONTEND_ORIGIN (also used
// for links in emails and OAuth redirects) plus any extras in ALLOWED_ORIGINS
// (comma-separated — e.g. a second deployment of the same frontend). Matching
// is exact: no wildcards, no suffix/prefix tricks, and a trailing slash or
// different scheme/port is a different origin.
export function allowedOrigins(env: { FRONTEND_ORIGIN?: string; ALLOWED_ORIGINS?: string }): string[] {
  const list = [env.FRONTEND_ORIGIN ?? "", ...(env.ALLOWED_ORIGINS ?? "").split(",")]
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== "*" && o !== "null");
  return [...new Set(list)];
}

export function corsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    // The response differs by caller's Origin, so caches must key on it.
    c.header("Vary", "Origin");
    const requestOrigin = c.req.header("Origin");
    // Reflect the caller's origin only if it is on the list. Anything else gets
    // no Access-Control-* headers, which makes the browser refuse to expose the
    // response to that page.
    if (requestOrigin && allowedOrigins(c.env).includes(requestOrigin)) {
      c.header("Access-Control-Allow-Origin", requestOrigin);
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
      c.header("Access-Control-Allow-Credentials", "true");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  };
}
