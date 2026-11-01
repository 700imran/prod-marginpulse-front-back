import { Hono } from "hono";
import type { Env } from "../config";
import { captchaConfigured } from "../security/turnstile";

// Unauthenticated by design (the login screen needs it before anyone is signed in).
// Exposes ONLY public values — the Turnstile *site* key is meant to be public; the secret never leaves the Worker.
export const publicConfigRoutes = new Hono<{ Bindings: Env }>();
publicConfigRoutes.get("/public", (c) => {
  // The login/sign-up widget only needs the PUBLIC site key (Supabase verifies those tokens with its own copy of the
  // secret), so the widget is on as soon as the key exists. `serverVerification` says whether THIS Worker can also
  // verify tokens (secret present) — that is what protects our own public routes such as ROI.
  const siteKey = c.env.TURNSTILE_SITE_KEY || null;
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ captcha: { provider: "turnstile", enabled: Boolean(siteKey), siteKey, serverVerification: captchaConfigured(c.env), actions: ["login", "signup", "roi"] } });
});
