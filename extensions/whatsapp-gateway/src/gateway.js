import fs from "node:fs/promises";
import path from "node:path";
import { signBody } from "./sign.js";
import { createMetrics } from "./metrics.js";
import { parseInbound, MAX_FILE_BYTES } from "./inbound.js";

const RETRYABLE = (s) => s === 408 || s === 425 || s === 429 || s >= 500;

/**
 * Core of the sidecar, with every dependency injected (fetch, sleep, clock, filesystem dir) so retry/spool/dedupe
 * behaviour is tested without WhatsApp or a network.
 *
 * Reliability model:
 *   1. forward() retries transient failures (network, 408/425/429/5xx) with exponential backoff + jitter, honouring Retry-After,
 *      and re-signs every attempt (so a long backoff never trips the Worker's ±300 s timestamp window).
 *   2. If it still fails, the payload is spooled to disk and retried by retrySpool() until it succeeds or is 24 h old.
 *   3. A 4xx (other than 408/425/429) is a configuration problem (bad secret, bad payload): never retried, counted, logged loudly.
 *   4. The Worker also dedupes on event_id, so a retry after a lost response cannot create a second document.
 */
export function createGateway(o) {
  const {
    workerUrl, webhookSecret, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), random = Math.random,
    log = console, spoolDir = null, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 30_000, requestTimeoutMs = 30_000,
    replyLimit = { max: 5, windowMs: 3_600_000 }, spoolMaxAgeMs = 24 * 3_600_000,
  } = o;
  const metrics = o.metrics ?? createMetrics();
  metrics.describe("mp_wa_messages_total", "Inbound WhatsApp messages by outcome");
  metrics.describe("mp_wa_forward_attempts_total", "HTTP attempts to the Worker, by result");
  metrics.describe("mp_wa_replies_total", "Replies sent to users, by outcome");
  metrics.describe("mp_wa_spool_files", "Payloads waiting on disk for a retry", "gauge");
  metrics.describe("mp_wa_spool_expired_total", "Payloads dropped after exceeding the spool age limit");
  const seen = new Map(); // eventId -> ts (bounded)
  const replies = new Map(); // from -> number[]

  const linkTries = new Map();
  const linkAllowed = (from) => { const t = now(), arr = (linkTries.get(from) ?? []).filter((x) => t - x < 3_600_000); if (arr.length >= 5) { linkTries.set(from, arr); return false; } arr.push(t); linkTries.set(from, arr); return true; };
  const rememberSeen = (id) => { seen.set(id, now()); if (seen.size > 2000) seen.delete(seen.keys().next().value); };
  const replyAllowed = (from) => {
    const t = now(), arr = (replies.get(from) ?? []).filter((x) => t - x < replyLimit.windowMs);
    if (arr.length >= replyLimit.max) { replies.set(from, arr); return false; }
    arr.push(t); replies.set(from, arr); return true;
  };

  async function attempt(payload) {
    const raw = JSON.stringify(payload);
    let res;
    try {
      res = await fetchImpl(workerUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-WA-Signature": signBody(webhookSecret, raw, Math.floor(now() / 1000)) }, body: raw, signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch (e) { metrics.inc("mp_wa_forward_attempts_total", { result: "network_error" }); return { retry: true, error: String(e?.message ?? e) }; }
    const text = await res.text().catch(() => "");
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    if (res.ok) { metrics.inc("mp_wa_forward_attempts_total", { result: "ok" }); return { ok: true, status: res.status, body }; }
    metrics.inc("mp_wa_forward_attempts_total", { result: RETRYABLE(res.status) ? "retryable_" + res.status : "rejected_" + res.status });
    const ra = Number(res.headers.get("retry-after"));
    return { retry: RETRYABLE(res.status), status: res.status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0, error: `worker returned ${res.status}` };
  }

  /** @returns {{ok:true,body:any}|{ok:false,retryable:boolean,error:string}} */
  async function forward(payload, attempts = maxAttempts) {
    let last;
    for (let i = 0; i < attempts; i++) {
      if (i) await sleep(Math.max(last?.retryAfterMs ?? 0, Math.min(maxDelayMs, baseDelayMs * 2 ** (i - 1)) * (0.5 + random() / 2)));
      last = await attempt(payload);
      if (last.ok) return { ok: true, body: last.body };
      if (!last.retry) { log.error?.(JSON.stringify({ level: "error", msg: "wa_forward_rejected", status: last.status, eventId: payload.event_id, hint: last.status === 401 ? "WA_GATEWAY_WEBHOOK_SECRET does not match the Worker's" : undefined })); return { ok: false, retryable: false, error: last.error }; }
    }
    return { ok: false, retryable: true, error: last?.error ?? "unknown" };
  }

  async function spoolWrite(payload) {
    if (!spoolDir) return false;
    await fs.mkdir(spoolDir, { recursive: true });
    const file = path.join(spoolDir, `${now()}-${payload.event_id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    await fs.writeFile(file + ".tmp", JSON.stringify(payload)); await fs.rename(file + ".tmp", file); // atomic: a crash never leaves a half-written payload
    return true;
  }

  /** Re-attempt payloads that could not be delivered. Call on an interval. */
  async function retrySpool() {
    if (!spoolDir) return { delivered: 0, remaining: 0, expired: 0 };
    let names = [];
    try { names = (await fs.readdir(spoolDir)).filter((n) => n.endsWith(".json")).sort(); } catch { return { delivered: 0, remaining: 0, expired: 0 }; }
    let delivered = 0, expired = 0;
    for (const n of names) {
      const file = path.join(spoolDir, n);
      const ts = Number(n.split("-")[0]);
      if (Number.isFinite(ts) && now() - ts > spoolMaxAgeMs) { await fs.rm(file, { force: true }); expired++; metrics.inc("mp_wa_spool_expired_total"); log.error?.(JSON.stringify({ level: "error", msg: "wa_spool_expired", file: n })); continue; }
      let payload; try { payload = JSON.parse(await fs.readFile(file, "utf8")); } catch { await fs.rm(file, { force: true }); continue; }
      const r = await forward(payload, 2);
      if (r.ok || !r.retryable) { await fs.rm(file, { force: true }); if (r.ok) delivered++; } // a permanent rejection will never succeed: drop it (already logged)
      else break; // the Worker is still down; stop hammering it, try again next tick
    }
    const remaining = (await fs.readdir(spoolDir).catch(() => [])).filter((x) => x.endsWith(".json")).length;
    metrics.set("mp_wa_spool_files", remaining);
    return { delivered, remaining, expired };
  }

  /**
   * @param msg   Baileys WAMessage
   * @param deps  { download(): Promise<Buffer>, sendText(to, text): Promise<void> }
   */
  async function handleMessage(msg, deps) {
    const p = parseInbound(msg);
    if (!p.ok) { metrics.inc("mp_wa_messages_total", { outcome: "skipped_" + p.reason }); return { outcome: "skipped", reason: p.reason }; }
    if (seen.has(p.eventId)) { metrics.inc("mp_wa_messages_total", { outcome: "duplicate" }); return { outcome: "duplicate" }; }
    if (p.size > MAX_FILE_BYTES) { metrics.inc("mp_wa_messages_total", { outcome: "too_large" }); await maybeReply(p.from, "Sorry, that file is larger than 15 MB. Please send a smaller PDF or image.", deps); return { outcome: "too_large" }; }
    rememberSeen(p.eventId);
    if (p.type === "text") { // number-linking handshake: tiny, no download, but rate-limited per sender so codes cannot be guessed by hammering
      if (!linkAllowed(p.from)) { metrics.inc("mp_wa_messages_total", { outcome: "link_rate_limited" }); return { outcome: "link_rate_limited" }; }
      const r = await forward({ event_id: p.eventId, type: "text", from: p.from, text: p.text });
      if (!r.ok) { seen.delete(p.eventId); metrics.inc("mp_wa_messages_total", { outcome: "link_failed" }); return { outcome: "link_failed" }; }
      metrics.inc("mp_wa_messages_total", { outcome: r.body?.status ?? "ok" });
      if (r.body?.reply) await maybeReply(p.from, r.body.reply, deps);
      return { outcome: r.body?.status ?? "ok" };
    }
    let data;
    try { data = await deps.download(); } catch (e) { seen.delete(p.eventId); metrics.inc("mp_wa_messages_total", { outcome: "download_failed" }); log.error?.(JSON.stringify({ level: "error", msg: "wa_download_failed", eventId: p.eventId, error: String(e?.message ?? e) })); return { outcome: "download_failed" }; }
    if (data.length > MAX_FILE_BYTES) { metrics.inc("mp_wa_messages_total", { outcome: "too_large" }); return { outcome: "too_large" }; }
    const payload = { event_id: p.eventId, type: p.type, from: p.from, filename: p.filename, mime_type: p.mimeType, data_base64: data.toString("base64") };
    const r = await forward(payload);
    if (r.ok) {
      metrics.set("mp_wa_last_forward_timestamp_seconds", Math.floor(now() / 1000));
      metrics.inc("mp_wa_messages_total", { outcome: r.body?.status ?? "ok" });
      if (r.body?.reply) await maybeReply(p.from, r.body.reply, deps);
      return { outcome: r.body?.status ?? "ok" };
    }
    if (r.retryable && (await spoolWrite(payload))) { metrics.inc("mp_wa_messages_total", { outcome: "spooled" }); return { outcome: "spooled" }; }
    metrics.inc("mp_wa_messages_total", { outcome: r.retryable ? "lost" : "rejected" });
    if (r.retryable) log.error?.(JSON.stringify({ level: "error", msg: "wa_message_lost", eventId: p.eventId, hint: "no SPOOL_DIR configured" }));
    return { outcome: r.retryable ? "lost" : "rejected" };
  }

  async function maybeReply(to, text, deps) {
    if (!replyAllowed(to)) { metrics.inc("mp_wa_replies_total", { outcome: "rate_limited" }); return; }
    try { await deps.sendText(to, text); metrics.inc("mp_wa_replies_total", { outcome: "sent" }); }
    catch (e) { metrics.inc("mp_wa_replies_total", { outcome: "failed" }); log.warn?.(JSON.stringify({ level: "warn", msg: "wa_reply_failed", error: String(e?.message ?? e) })); }
  }

  return { handleMessage, forward, retrySpool, metrics };
}
