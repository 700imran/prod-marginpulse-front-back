import http from "node:http";
import QRCode from "qrcode";
import { safeEqual } from "./sign.js";

/** Small admin/ops HTTP surface. Everything except /health requires `Authorization: Bearer <token>`. */
export function createHttpServer({ token, getState, getQr, sendText, metrics, startedAt = Date.now() }) {
  const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  const authed = (req) => { const h = req.headers.authorization ?? ""; return token && h.startsWith("Bearer ") && safeEqual(h.slice(7), token); };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, state: getState(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }); // liveness: process is up
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/ready") return json(res, getState() === "open" ? 200 : 503, { ready: getState() === "open", state: getState() });
      if (req.method === "GET" && url.pathname === "/metrics") { res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }); return res.end(metrics.render()); }
      if (req.method === "GET" && url.pathname === "/qr") { const qr = getQr(); return json(res, qr ? 200 : 404, qr ? { qr } : { error: "no QR pending", state: getState() }); }
      if (req.method === "GET" && url.pathname === "/qr.svg") { const qr = getQr(); if (!qr) return json(res, 404, { error: "no QR pending", state: getState() }); res.writeHead(200, { "Content-Type": "image/svg+xml" }); return res.end(await QRCode.toString(qr, { type: "svg" })); }
      if (req.method === "POST" && url.pathname === "/send") {
        let body = ""; for await (const c of req) { body += c; if (body.length > 8192) return json(res, 413, { error: "payload too large" }); }
        let j; try { j = JSON.parse(body); } catch { return json(res, 400, { error: "invalid json" }); }
        if (typeof j?.to !== "string" || typeof j?.text !== "string" || !j.text) return json(res, 400, { error: "to and text are required" });
        try { await sendText(j.to, j.text); return json(res, 200, { ok: true }); }
        catch (e) { const m = String(e?.message ?? e); return json(res, /not connected/.test(m) ? 503 : /invalid recipient/.test(m) ? 400 : /rate limit/.test(m) ? 429 : 502, { error: m }); }
      }
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: "internal error" }); }
  });
}
