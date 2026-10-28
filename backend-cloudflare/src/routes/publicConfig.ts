import { Hono } from "hono";
import type { Env } from "../config";
import { captchaConfigured } from "../security/turnstile";

// Unauthenticated by design (the login screen needs it before anyone is signed in).
// Exposes ONLY public values — the Turnstile *site* key is meant to be public; the secret never leaves the Worker.
export const publicConfigRoutes = new Hono<{ Bindings: Env }>();
publicConfigRoutes.get("/public", (c) => {
  const enabled = captchaConfigured(c.env);
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ captcha: { provider: "turnstile", enabled, siteKey: enabled ? c.env.TURNSTILE_SITE_KEY : null, actions: ["login", "signup", "roi"] } });
});
