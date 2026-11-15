import { checkQuotaForTenant } from "../billing/limits";
import { emit } from "../observability/events";
import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { getTenantByWhatsAppPhone, getTenantByIngestEmailAlias } from "../repository/tenants";
import { createDocument } from "../repository/documents";
import { uploadBytes } from "../storage";
import { verifyMetaSignature256 } from "../security/hmac";
import { constantTimeEqual, isTrustedMediaUrl } from "../security/webhookAuth";
import { validateUpload, safeFilename } from "../security/upload";
import { isProd } from "../config";
import { fetchExternal, EXTERNAL_TIMEOUTS } from "../lib/external";
import { upiGatewayWebhook } from "./upi";
import { verifyTimestampedHmac } from "../billing/upi";
import { claimWebhookEvent, releaseWebhookEvent } from "../repository/webhookEvents";
import { consumeLinkCode, LINK_TEXT_RE } from "../repository/whatsappLink";

// Unauthenticated by nature — these are called by Meta/an email relay,
// not by a logged-in tenant. Mounted separately in src/index.ts (not
// under requireAuth). The POST handler now verifies the
// X-Hub-Signature-256 header against WHATSAPP_APP_SECRET (the Go
// original didn't implement this — only the GET handshake token was
// checked — so this closes a gap rather than preserving one). If
// WHATSAPP_APP_SECRET isn't configured, it falls back to the old
// unverified behavior rather than hard-failing, consistent with this
// codebase's pattern of graceful degradation for optional secrets —
// but it logs a warning each time so that fallback isn't silent.
export const webhookRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

webhookRoutes.get("/whatsapp", async (c) => {
  const q = c.req.query();
  const expected = c.env.WHATSAPP_VERIFY_TOKEN;
  if (expected && q["hub.mode"] === "subscribe" && (await constantTimeEqual(q["hub.verify_token"] ?? "", expected))) {
    return c.text((q["hub.challenge"] ?? "").slice(0, 200));
  }
  return c.json({ error: "Verification failed" }, 403);
});

interface WAMessage {
  from: string;
  id: string;
  type: string;
  document?: { id: string; mime_type: string; filename: string };
  image?: { id: string; mime_type: string };
}
interface WAWebhookPayload {
  entry: { changes: { value: { messages?: WAMessage[] } }[] }[];
}

async function downloadWhatsAppMedia(env: Env, mediaId: string): Promise<{ data: ArrayBuffer; mimeType: string } | null> {
  if (!env.WHATSAPP_ACCESS_TOKEN) return null;
  const lookupResp = await fetchExternal("media", `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  const meta = (await lookupResp.json()) as { url?: string; mime_type?: string };
  if (!meta.url || !isTrustedMediaUrl(meta.url)) return null;
  const mediaResp = await fetchExternal("media", meta.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, redirect: "error" });
  if (!mediaResp.ok) return null;
  const declared = parseInt(mediaResp.headers.get("content-length") ?? "0", 10);
  if (declared > 15 * 1024 * 1024) return null;
  const data = await mediaResp.arrayBuffer();
  if (data.byteLength > 15 * 1024 * 1024) return null;
  return { data, mimeType: meta.mime_type ?? "" };
}

/** Validate → store in R2 → create the document row → queue OCR. Shared by Meta's webhook and the WhatsApp gateway webhook. */
export async function storeWhatsAppDocument(env: Env, sql: Sql, tenantId: string, m: { messageId: string; from: string; filename: string; mimeType: string; data: ArrayBuffer }):
  Promise<{ ok: true; documentId: string; filename: string } | { ok: false; reason: string; quota?: boolean }> {
  const base = safeFilename(m.filename || "whatsapp-media");
  const ext = /\.[a-z0-9]{2,4}$/i.test(m.filename || "") ? "" : m.mimeType === "application/pdf" ? ".pdf" : m.mimeType === "image/png" ? ".png" : ".jpg";
  const verdict = validateUpload(base + ext, m.data.byteLength, new Uint8Array(m.data.slice(0, 16)));
  if (!verdict.ok) { console.warn("whatsapp media rejected", { reason: verdict.error }); return { ok: false, reason: verdict.error }; }
  const over = await checkQuotaForTenant(sql, env, tenantId, { docs: 1 });
  if (over) return { ok: false, reason: over.error, quota: true };
  const storageKey = `${tenantId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/${crypto.randomUUID()}`;
  try {
    await uploadBytes(env, storageKey, m.data, verdict.mime);
    const doc = await createDocument(sql, { tenantId, docType: "INVOICE", originalFilename: base, storageKey, mimeType: verdict.mime, fileSizeBytes: m.data.byteLength, ingestChannel: "WHATSAPP" });
    await sql`update documents set whatsapp_message_id = ${m.messageId}, sender_phone = ${m.from} where tenant_id = ${tenantId} and document_id = ${doc.documentId}`;
    await env.OCR_QUEUE.send({ task: "run_ocr_pipeline", job_id: crypto.randomUUID(), args: { tenant_id: tenantId, document_id: doc.documentId, storage_key: storageKey, mime_type: verdict.mime } });
    return { ok: true, documentId: doc.documentId, filename: base };
  } catch (e) {
    console.error("whatsapp document ingest failed", { error: (e as Error).message });
    throw e;
  }
}

webhookRoutes.post("/whatsapp", async (c) => {
  const rawBody = await c.req.text();
  if (!c.env.WHATSAPP_APP_SECRET && isProd(c.env)) {
    // Fail CLOSED in production: without the app secret anyone could forge inbound
    // messages and inject documents into any tenant bound to a phone number.
    console.error("whatsapp webhook: WHATSAPP_APP_SECRET missing in production, rejecting");
    return c.json({ error: "webhook not configured" }, 503);
  }
  if (c.env.WHATSAPP_APP_SECRET) {
    const valid = await verifyMetaSignature256(c.env.WHATSAPP_APP_SECRET, rawBody, c.req.header("X-Hub-Signature-256") ?? null);
    if (!valid) {
      console.warn("whatsapp webhook: signature verification failed, rejecting");
      emit("webhook_rejected", { reason: "bad_signature", source: "whatsapp" });
      return c.json({ error: "Invalid signature" }, 401);
    }
  } else {
    console.warn("whatsapp webhook: WHATSAPP_APP_SECRET not configured, accepting without signature verification");
  }

  let payload: WAWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const sql = c.get("sql");

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value.messages ?? []) {
        let mediaId: string, mimeType: string, filename: string;
        if (msg.document) ({ id: mediaId, mime_type: mimeType, filename } = msg.document);
        else if (msg.image) (({ id: mediaId, mime_type: mimeType } = msg.image), (filename = "whatsapp-image"));
        else continue;

        const tenant = await getTenantByWhatsAppPhone(sql, msg.from);
        if (!tenant) {
          console.warn("whatsapp message from unbound number", { from: msg.from });
          continue;
        }

        const media = await downloadWhatsAppMedia(c.env, mediaId).catch((e) => {
          console.error("whatsapp media download failed", { error: e.message, mediaId });
          return null;
        });
        if (!media) continue;
        try { await storeWhatsAppDocument(c.env, sql, tenant.tenantId, { messageId: msg.id, from: msg.from, filename, mimeType, data: media.data }); }
        catch { /* already logged; one bad message must not fail Meta's whole delivery batch */ }
      }
    }
  }
  return c.json({ status: "received" });
});

webhookRoutes.post("/upi-gateway", upiGatewayWebhook as never);

// ── WhatsApp gateway (Baileys sidecar, extensions/whatsapp-gateway) ──────────
// The sidecar is a logged-in WhatsApp Web session on a spare number. It forwards each inbound document/image here, signed
// `t=<unix>,v1=<hmac("t.rawBody")>` (same scheme as the UPI gateway), and sends back whatever we put in `reply`.
// Free alternative for testing when the official Cloud API isn't available; it is NOT an official WhatsApp channel.
webhookRoutes.post("/whatsapp-gateway", async (c) => {
  if (!c.env.WA_GATEWAY_WEBHOOK_SECRET) return c.json({ error: "webhook not configured" }, 503);
  const raw = await c.req.text();
  const sig = await verifyTimestampedHmac(c.env.WA_GATEWAY_WEBHOOK_SECRET, raw, c.req.header("X-WA-Signature"));
  if (!sig.ok) { emit("webhook_rejected", { reason: sig.reason, source: "whatsapp_gateway" }); return c.json({ error: "Invalid signature" }, 401); }

  let m: { event_id?: unknown; type?: unknown; from?: unknown; filename?: unknown; mime_type?: unknown; data_base64?: unknown; text?: unknown };
  try { m = JSON.parse(raw); } catch { return c.json({ error: "invalid json" }, 400); }
  const eventId = typeof m.event_id === "string" && /^[A-Za-z0-9_.-]{6,128}$/.test(m.event_id) ? m.event_id : null;
  const from = typeof m.from === "string" && /^\d{8,15}$/.test(m.from) ? m.from : null;
  const isFile = (m.type === "document" || m.type === "image") && typeof m.data_base64 === "string";
  const isText = m.type === "text" && typeof m.text === "string" && m.text.length <= 100;
  if (!eventId || !from || !(isFile || isText)) return c.json({ error: "event_id, from and either (type document|image + data_base64) or (type text + text) are required" }, 400);
  if (isFile && (m.data_base64 as string).length > 21 * 1024 * 1024) return c.json({ error: "file too large" }, 413);

  const sql = c.get("sql");
  if (!(await claimWebhookEvent(sql, "whatsapp_gateway", eventId))) return c.json({ status: "duplicate" });
  try {
    if (isText) { // the only text we act on is `LINK <code>`; anything else is ignored silently (never answer strangers)
      const lm = LINK_TEXT_RE.exec(m.text as string);
      if (!lm) return c.json({ status: "ignored_text" });
      const r = await consumeLinkCode(sql, lm[1]!, from);
      emit("whatsapp_gateway", { outcome: r.ok ? "linked" : "link_" + r.reason });
      if (r.ok) return c.json({ status: "linked", reply: "✅ This WhatsApp number is now linked to your MarginPulse account. Send invoices here as PDF or photos and they will appear under Documents." });
      return c.json({ status: "link_failed", reply: r.reason === "conflict" ? "This number is already linked to another MarginPulse account. Unlink it there first." : "That code is invalid or has expired. Generate a new one in MarginPulse and try again." });
    }
    const tenant = await getTenantByWhatsAppPhone(sql, from);
    if (!tenant) { emit("whatsapp_gateway", { outcome: "unbound_number" }); return c.json({ status: "unbound_number" }); } // no reply: never message strangers from a ban-prone number
    let data: ArrayBuffer;
    try { data = base64ToArrayBuffer(m.data_base64 as string); } catch { return c.json({ status: "rejected", reply: "Sorry, we couldn't read that file." }); }
    const r = await storeWhatsAppDocument(c.env, sql, tenant.tenantId, { messageId: eventId, from, filename: typeof m.filename === "string" ? m.filename : (m.type === "image" ? "whatsapp-image" : "whatsapp-document"), mimeType: typeof m.mime_type === "string" ? m.mime_type : "", data });
    if (!r.ok) {
      emit("whatsapp_gateway", { outcome: r.quota ? "plan_limit" : "rejected" });
      return c.json({ status: "rejected", reply: r.quota ? "Your MarginPulse Free plan's monthly document limit is reached, so this file was not added. Upgrade in the app to add more." : "Sorry, we can only accept PDF, JPG or PNG files up to 15 MB." });
    }
    emit("whatsapp_gateway", { outcome: "received" });
    return c.json({ status: "received", documentId: r.documentId, reply: `✅ Received ${r.filename}. It will appear under Documents in MarginPulse shortly.` });
  } catch (e) {
    await releaseWebhookEvent(sql, "whatsapp_gateway", eventId).catch(() => {}); // let the sidecar's retry process it
    emit("whatsapp_gateway", { outcome: "error" });
    console.error(JSON.stringify({ level: "error", msg: "whatsapp_gateway_failed", eventId, error: (e as Error).message }));
    return c.json({ error: "temporarily unable to process" }, 500);
  }
});

webhookRoutes.post("/email-ingest", async (c) => {
  // Secret is MANDATORY (was optional: an unset secret left this endpoint wide open).
  if (!c.env.WEBHOOK_INGEST_SECRET) return c.json({ error: "webhook not configured" }, 503);
  if (!(await constantTimeEqual(c.req.header("X-Webhook-Secret") ?? "", c.env.WEBHOOK_INGEST_SECRET))) { emit("webhook_rejected", { reason: "bad_secret", source: "email_ingest" }); return c.json({ error: "Invalid webhook secret" }, 401); }

  const payload = await c.req.json<{ to: string; from: string; attachments: { filename: string; content_type: string; content_base64: string }[] }>().catch(() => null);
  if (!payload || typeof payload.to !== "string") return c.json({ error: "invalid payload" }, 400);
  if ((payload.attachments?.length ?? 0) > 10) return c.json({ error: "too many attachments (max 10)" }, 413);
  const alias = extractEmailAlias(payload.to);
  const sql = c.get("sql");
  const tenant = await getTenantByIngestEmailAlias(sql, alias);
  if (!tenant) return c.json({ error: "No tenant bound to this ingest address" }, 404);

  let queued = 0;
  for (const att of payload.attachments ?? []) {
    if (typeof att?.content_base64 !== "string" || att.content_base64.length > 21 * 1024 * 1024) continue; // ~15MB decoded
    let data: ArrayBuffer;
    try {
      data = base64ToArrayBuffer(att.content_base64);
    } catch {
      continue;
    }
    const name = safeFilename(String(att.filename ?? "attachment"));
    const verdict = validateUpload(name, data.byteLength, new Uint8Array(data.slice(0, 16)));
    if (!verdict.ok) { console.warn("email attachment rejected", { reason: verdict.error }); continue; }
    if (await checkQuotaForTenant(sql, c.env, tenant.tenantId, { docs: 1 })) { emit("quota", { resource: "documents", outcome: "email_dropped" }); continue; }
    const storageKey = `${tenant.tenantId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/${crypto.randomUUID()}-${name}`;
    try {
      await uploadBytes(c.env, storageKey, data, verdict.mime);
      const doc = await createDocument(sql, { tenantId: tenant.tenantId, docType: "INVOICE", originalFilename: name, storageKey, mimeType: verdict.mime, fileSizeBytes: data.byteLength, ingestChannel: "EMAIL" });
      await c.env.OCR_QUEUE.send({ task: "run_ocr_pipeline", job_id: crypto.randomUUID(), args: { tenant_id: tenant.tenantId, document_id: doc.documentId, storage_key: storageKey, mime_type: verdict.mime } });
      queued++;
    } catch (e) {
      console.error("email attachment ingest failed", { error: (e as Error).message });
    }
  }
  return c.json({ status: "received", documents_queued: queued });
});

function extractEmailAlias(to: string): string {
  const at = to.indexOf("@");
  return (at === -1 ? to : to.slice(0, at)).trim().toLowerCase();
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
