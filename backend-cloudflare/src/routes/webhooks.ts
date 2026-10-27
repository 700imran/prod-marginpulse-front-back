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
  const lookupResp = await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  const meta = (await lookupResp.json()) as { url?: string; mime_type?: string };
  if (!meta.url || !isTrustedMediaUrl(meta.url)) return null;
  const mediaResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, redirect: "error" });
  if (!mediaResp.ok) return null;
  const declared = parseInt(mediaResp.headers.get("content-length") ?? "0", 10);
  if (declared > 15 * 1024 * 1024) return null;
  const data = await mediaResp.arrayBuffer();
  if (data.byteLength > 15 * 1024 * 1024) return null;
  return { data, mimeType: meta.mime_type ?? "" };
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
        const verdict = validateUpload(safeFilename(filename || "whatsapp-media") + (/\.[a-z0-9]{2,4}$/i.test(filename || "") ? "" : mimeType === "application/pdf" ? ".pdf" : mimeType === "image/png" ? ".png" : ".jpg"), media.data.byteLength, new Uint8Array(media.data.slice(0, 16)));
        if (!verdict.ok) { console.warn("whatsapp media rejected", { reason: verdict.error }); continue; }
        mimeType = verdict.mime;
        filename = safeFilename(filename || "whatsapp-media");

        const storageKey = `${tenant.tenantId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/${crypto.randomUUID()}`;
        try {
          await uploadBytes(c.env, storageKey, media.data, mimeType);
          const doc = await createDocument(sql, { tenantId: tenant.tenantId, docType: "INVOICE", originalFilename: filename, storageKey, mimeType, fileSizeBytes: media.data.byteLength, ingestChannel: "WHATSAPP" });
          await sql`update documents set whatsapp_message_id = ${msg.id}, sender_phone = ${msg.from} where tenant_id = ${tenant.tenantId} and document_id = ${doc.documentId}`;
          await c.env.OCR_QUEUE.send({ task: "run_ocr_pipeline", job_id: crypto.randomUUID(), args: { tenant_id: tenant.tenantId, document_id: doc.documentId, storage_key: storageKey, mime_type: mimeType } });
        } catch (e) {
          console.error("whatsapp document ingest failed", { error: (e as Error).message });
        }
      }
    }
  }
  return c.json({ status: "received" });
});

webhookRoutes.post("/email-ingest", async (c) => {
  // Secret is MANDATORY (was optional: an unset secret left this endpoint wide open).
  if (!c.env.WEBHOOK_INGEST_SECRET) return c.json({ error: "webhook not configured" }, 503);
  if (!(await constantTimeEqual(c.req.header("X-Webhook-Secret") ?? "", c.env.WEBHOOK_INGEST_SECRET))) return c.json({ error: "Invalid webhook secret" }, 401);

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
