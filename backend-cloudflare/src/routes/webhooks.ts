import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { getTenantByWhatsAppPhone, getTenantByIngestEmailAlias } from "../repository/tenants";
import { createDocument } from "../repository/documents";
import { uploadBytes } from "../storage";
import { verifyMetaSignature256 } from "../security/hmac";

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

webhookRoutes.get("/whatsapp", (c) => {
  const q = c.req.query();
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === c.env.WHATSAPP_VERIFY_TOKEN) {
    return c.text(q["hub.challenge"] ?? "");
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
  if (!meta.url) return null;
  const mediaResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } });
  return { data: await mediaResp.arrayBuffer(), mimeType: meta.mime_type ?? "" };
}

webhookRoutes.post("/whatsapp", async (c) => {
  const rawBody = await c.req.text();
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
        if (media.mimeType) mimeType = media.mimeType;

        const storageKey = `${tenant.tenantId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/${crypto.randomUUID()}`;
        try {
          await uploadBytes(c.env, storageKey, media.data, mimeType);
          const doc = await createDocument(sql, { tenantId: tenant.tenantId, docType: "INVOICE", originalFilename: filename, storageKey, mimeType, fileSizeBytes: media.data.byteLength, ingestChannel: "WHATSAPP" });
          await sql`update documents set whatsapp_message_id = ${msg.id}, sender_phone = ${msg.from} where document_id = ${doc.documentId}`;
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
  if (c.env.WEBHOOK_INGEST_SECRET) {
    if (c.req.header("X-Webhook-Secret") !== c.env.WEBHOOK_INGEST_SECRET) return c.json({ error: "Invalid webhook secret" }, 401);
  }

  const payload = await c.req.json<{ to: string; from: string; attachments: { filename: string; content_type: string; content_base64: string }[] }>();
  const alias = extractEmailAlias(payload.to);
  const sql = c.get("sql");
  const tenant = await getTenantByIngestEmailAlias(sql, alias);
  if (!tenant) return c.json({ error: "No tenant bound to this ingest address" }, 404);

  let queued = 0;
  for (const att of payload.attachments ?? []) {
    let data: ArrayBuffer;
    try {
      data = base64ToArrayBuffer(att.content_base64);
    } catch {
      continue;
    }
    const storageKey = `${tenant.tenantId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/${crypto.randomUUID()}-${att.filename}`;
    try {
      await uploadBytes(c.env, storageKey, data, att.content_type);
      const doc = await createDocument(sql, { tenantId: tenant.tenantId, docType: "INVOICE", originalFilename: att.filename, storageKey, mimeType: att.content_type, fileSizeBytes: data.byteLength, ingestChannel: "EMAIL" });
      await c.env.OCR_QUEUE.send({ task: "run_ocr_pipeline", job_id: crypto.randomUUID(), args: { tenant_id: tenant.tenantId, document_id: doc.documentId, storage_key: storageKey, mime_type: att.content_type } });
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
