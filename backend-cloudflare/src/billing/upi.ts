// Backup payment path for when Razorpay is down/unconfigured. Two modes, both OFF unless UPI_FALLBACK_ENABLED="true":
//   gateway — an upi-gateway (github.com/mynkdev-21/upi-gateway, self-hosted) creates the order; its signed webhook (or a
//             status poll) tells us it was paid.
//   manual  — we show a upi:// intent for UPI_VPA; the customer pays in any UPI app and submits the 12-digit UTR; a
//             platform admin checks the bank credit and approves. Nothing is auto-trusted.
// Pure helpers live here (no I/O) so they are unit-testable; routes/upi.ts does the I/O.
import type { Env } from "../config";
import { hmacSha256Hex, timingSafeEqual } from "../lib_razorpay_sig";
import { fetchExternal, EXTERNAL_TIMEOUTS, ExternalCallError, isRetryableStatus } from "../lib/external";

export type UpiMode = "gateway" | "manual";
type UpiEnv = Pick<Env, "UPI_FALLBACK_ENABLED" | "UPI_VPA" | "UPI_GATEWAY_BASE_URL" | "UPI_GATEWAY_API_KEY" | "UPI_GATEWAY_API_SECRET" | "UPI_GATEWAY_WEBHOOK_SECRET">;

const VPA_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,32}$/;
export const isValidVpa = (v: unknown): v is string => typeof v === "string" && VPA_RE.test(v);
export const isValidUtr = (v: unknown): v is string => typeof v === "string" && /^\d{12}$/.test(v.trim());

/** Which fallback (if any) is switched on AND fully configured. A half-configured mode is treated as off. */
export function upiMode(env: UpiEnv): UpiMode | null {
  if (env.UPI_FALLBACK_ENABLED !== "true") return null;
  if (env.UPI_GATEWAY_BASE_URL && env.UPI_GATEWAY_API_KEY && env.UPI_GATEWAY_API_SECRET && env.UPI_GATEWAY_WEBHOOK_SECRET) return "gateway";
  if (isValidVpa(env.UPI_VPA)) return "manual";
  return null;
}

/** upi://pay deep link (NPCI UPI linking spec). `tr` is our reference so the credit can be matched on the bank statement. */
export function buildUpiIntent(o: { vpa: string; payeeName: string; amountInr: number; reference: string; note: string }): string {
  if (!isValidVpa(o.vpa)) throw new Error("invalid VPA");
  if (!Number.isFinite(o.amountInr) || o.amountInr <= 0) throw new Error("invalid amount");
  const q = new URLSearchParams({ pa: o.vpa, pn: o.payeeName.slice(0, 40), am: o.amountInr.toFixed(2), cu: "INR", tn: o.note.slice(0, 50), tr: o.reference });
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

/** Short, unambiguous, unique reference shown to the customer (no 0/O/1/I). */
export function newReference(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "MP" + [...bytes].map((b) => A[b % A.length]).join("");
}

export type SigResult = { ok: true; timestamp: number } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" | "no_secret" };

/** Timestamped HMAC used by upi-gateway AND our WhatsApp sidecar: `t=<unix>,v1=<hex hmac-sha256 of "t.rawBody">`, rejected outside ±300 s. */
export async function verifyTimestampedHmac(secret: string | undefined, rawBody: string, header: string | null | undefined, nowMs = Date.now(), toleranceSec = 300): Promise<SigResult> {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing" };
  const m = /^t=(\d{9,12}),v1=([a-f0-9]{64})$/.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const ts = Number(m[1]);
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return { ok: false, reason: "stale" };
  const expected = await hmacSha256Hex(secret, `${m[1]}.${rawBody}`);
  return timingSafeEqual(expected, m[2]!) ? { ok: true, timestamp: ts } : { ok: false, reason: "mismatch" };
}

export const verifyUpiGatewaySignature = verifyTimestampedHmac;

// ── upi-gateway REST client ────────────────────────────────────────────────
export interface GatewayOrder { orderId: string; clientOrderId: string; amountInr: number; status: string; paymentUrl: string | null; upiIntent: string | null; expiresAt: string | null; live: boolean }
export class GatewayError extends Error { constructor(public retryable: boolean, message: string) { super(message); this.name = "GatewayError"; } }
type FetchLike = typeof fetch;

function baseUrl(env: Pick<Env, "UPI_GATEWAY_BASE_URL" | "ENVIRONMENT">): string {
  const raw = (env.UPI_GATEWAY_BASE_URL ?? "").replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(raw); } catch { throw new GatewayError(false, "UPI_GATEWAY_BASE_URL is not a valid URL"); }
  if (u.protocol !== "https:" && !(env.ENVIRONMENT !== "production" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new GatewayError(false, "UPI_GATEWAY_BASE_URL must be https");
  return raw;
}

function parseOrder(json: any): GatewayOrder {
  const d = json?.data;
  if (!json?.success || typeof d?.order_id !== "string") throw new GatewayError(false, "unexpected gateway response");
  return {
    orderId: d.order_id, clientOrderId: String(d.client_order_id ?? ""), amountInr: Number(d.amount), status: String(d.status ?? "").toLowerCase(),
    paymentUrl: typeof d.payment_url === "string" ? d.payment_url : null, upiIntent: typeof d.upi_intent === "string" ? d.upi_intent : null,
    expiresAt: typeof d.expires_at === "string" ? d.expires_at : null, live: d.test !== true && String(d.environment ?? "live").toLowerCase() === "live",
  };
}

/** One bounded retry for transient failures (network/timeout/5xx/429). The caller owns idempotency (client_order_id). */
async function gatewayCall(env: Env, method: "GET" | "POST", path: string, body?: unknown, fetchImpl?: FetchLike): Promise<any> {
  const url = `${baseUrl(env)}${path}`;
  const init: RequestInit = { method, headers: { "X-Api-Key": env.UPI_GATEWAY_API_KEY!, "X-Api-Secret": env.UPI_GATEWAY_API_SECRET!, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined, redirect: "error" };
  let lastErr: GatewayError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
    try {
      const res = await (fetchImpl ? fetchImpl(url, { ...init, signal: AbortSignal.timeout(EXTERNAL_TIMEOUTS.payments) }) : fetchExternal("upi_gateway", url, init, EXTERNAL_TIMEOUTS.payments));
      if (res.ok) return await res.json();
      lastErr = new GatewayError(isRetryableStatus(res.status), `gateway returned ${res.status}`);
      if (!lastErr.retryable) throw lastErr;
    } catch (e) {
      if (e instanceof GatewayError && !e.retryable) throw e;
      lastErr = e instanceof GatewayError ? e : new GatewayError(true, e instanceof ExternalCallError ? e.message : `gateway request failed: ${(e as Error).message}`);
    }
  }
  throw lastErr ?? new GatewayError(true, "gateway unavailable");
}

export const createGatewayOrder = async (env: Env, o: { amountInr: number; clientOrderId: string }, f?: FetchLike) =>
  parseOrder(await gatewayCall(env, "POST", "/api/v1/orders", { amount: o.amountInr, client_order_id: o.clientOrderId }, f));
export const getGatewayOrder = async (env: Env, orderId: string, f?: FetchLike) =>
  parseOrder(await gatewayCall(env, "GET", `/api/v1/orders/${encodeURIComponent(orderId)}`, undefined, f));
