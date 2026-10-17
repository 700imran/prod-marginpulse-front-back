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

export function corsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.env.FRONTEND_ORIGIN;
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
    c.header("Access-Control-Allow-Credentials", "true");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  };
}
