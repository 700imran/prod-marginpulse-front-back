// Entry point. Config via environment — see README.md.
import pino from "pino";
import QRCode from "qrcode";
import { createGateway } from "./gateway.js";
import { createConnection } from "./connection.js";
import { createHttpServer } from "./http.js";
import { createMetrics } from "./metrics.js";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing required env var ${k}`); process.exit(1); } return v; };
const workerUrl = need("WORKER_WEBHOOK_URL");            // https://<your-api>/webhook/whatsapp-gateway
const webhookSecret = need("WA_GATEWAY_WEBHOOK_SECRET");  // same value as the Worker secret
const token = need("WA_GATEWAY_TOKEN");                   // bearer token for /metrics, /qr, /send
if (!/^https:\/\//.test(workerUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(workerUrl)) { console.error("WORKER_WEBHOOK_URL must be https"); process.exit(1); }

const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });
const metrics = createMetrics();
metrics.describe("mp_wa_process_start_time_seconds", "Process start time", "gauge");
metrics.set("mp_wa_process_start_time_seconds", Math.floor(Date.now() / 1000));

const gateway = createGateway({ workerUrl, webhookSecret, metrics, spoolDir: process.env.SPOOL_DIR ?? "./data/spool" });
const baileys = await import("@whiskeysockets/baileys");
const conn = createConnection({
  baileys, metrics, logger, authDir: process.env.AUTH_DIR ?? "./data/auth",
  onMessage: (m, deps) => gateway.handleMessage(m, deps),
  onQr: async (qr) => { console.log("\nScan this QR with WhatsApp → Linked devices → Link a device:\n" + (await QRCode.toString(qr, { type: "terminal", small: true }))); },
});

const server = createHttpServer({ token, metrics, getState: conn.getState, getQr: conn.getQr, sendText: conn.sendText });
server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "0.0.0.0", () => console.log(JSON.stringify({ level: "info", msg: "wa_gateway_listening", port: process.env.PORT ?? 8787 })));

await conn.start();
const spoolTimer = setInterval(() => gateway.retrySpool().catch((e) => console.error(JSON.stringify({ level: "error", msg: "wa_spool_retry_failed", error: String(e?.message ?? e) }))), 60_000);
spoolTimer.unref();

process.on("unhandledRejection", (e) => console.error(JSON.stringify({ level: "error", msg: "unhandled_rejection", error: String(e?.message ?? e) })));
process.on("uncaughtException", (e) => { console.error(JSON.stringify({ level: "error", msg: "uncaught_exception", error: String(e?.stack ?? e) })); process.exit(1); }); // let the supervisor restart a corrupted process
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { conn.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
