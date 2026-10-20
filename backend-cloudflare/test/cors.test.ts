// CORS: the browser only lets a page read API responses if the response names
// that page's origin. A single hard-coded origin meant a frontend served from
// anywhere else (e.g. the workers.dev deployment) got every response blocked.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { corsMiddleware, allowedOrigins } from "../src/middleware/security";

const ENV = { FRONTEND_ORIGIN: "https://marginpulse-app.vercel.app", ALLOWED_ORIGINS: "https://prod-marginpulse-frontend.imrankhan210r.workers.dev, https://staging.example.com" } as any;
const app = () => { const a = new Hono<any>(); a.use("*", corsMiddleware()); a.get("/x", (c) => c.json({ ok: 1 })); return a; };
const req = (origin?: string, method = "GET", env = ENV) =>
  app().request("/x", { method, headers: origin ? { Origin: origin } : {} }, env);

describe("CORS", () => {
  it.each([
    "https://marginpulse-app.vercel.app",
    "https://prod-marginpulse-frontend.imrankhan210r.workers.dev",
    "https://staging.example.com",
  ])("allows %s, reflecting exactly that origin, with credentials", async (o) => {
    const r = await req(o);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(o);
    expect(r.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(r.headers.get("Vary")).toMatch(/Origin/);
    expect(r.status).toBe(200);
  });

  it.each([
    "https://evil.example.com",
    "https://marginpulse-app.vercel.app.evil.com",       // suffix trick
    "https://evil-marginpulse-app.vercel.app",           // prefix trick
    "http://marginpulse-app.vercel.app",                 // wrong scheme
    "https://marginpulse-app.vercel.app/",               // trailing slash is a different string
    "https://marginpulse-app.vercel.app:8443",           // wrong port
    "null",                                              // sandboxed iframes / file://
    "*",
  ])("does NOT allow %s", async (o) => {
    const r = await req(o);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("preflight from an allowed origin gets the allow headers and 204", async () => {
    const r = await req("https://prod-marginpulse-frontend.imrankhan210r.workers.dev", "OPTIONS");
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://prod-marginpulse-frontend.imrankhan210r.workers.dev");
    expect(r.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(r.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("preflight from a disallowed origin is answered but carries no allow headers", async () => {
    const r = await req("https://evil.example.com", "OPTIONS");
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("requests without an Origin (curl, server-to-server, health pingers) still work", async () => {
    const r = await req(undefined);
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("with ALLOWED_ORIGINS unset it behaves like the old single-origin setup", async () => {
    const env = { FRONTEND_ORIGIN: "https://marginpulse-app.vercel.app" } as any;
    expect((await req("https://marginpulse-app.vercel.app", "GET", env)).headers.get("Access-Control-Allow-Origin")).toBe("https://marginpulse-app.vercel.app");
    expect((await req("https://prod-marginpulse-frontend.imrankhan210r.workers.dev", "GET", env)).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("a wildcard or 'null' in the config is ignored, never honoured", () => {
    expect(allowedOrigins({ FRONTEND_ORIGIN: "https://a.com", ALLOWED_ORIGINS: "*, null, ,https://b.com" })).toEqual(["https://a.com", "https://b.com"]);
  });

  it("the committed wrangler.toml allows the workers.dev frontend", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/ALLOWED_ORIGINS\s*=\s*"[^"]*prod-marginpulse-frontend\.imrankhan210r\.workers\.dev/);
  });
});
