// Pure: turns a Baileys WAMessage into what we forward, or a reason to skip it. No I/O, so it is fully unit-tested.
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const LINK_RE = /^\s*LINK\s+[A-Za-z0-9]{6}\s*$/i;

const unwrap = (m) => {
  let cur = m;
  for (let i = 0; i < 4 && cur; i++) {
    const inner = cur.ephemeralMessage?.message ?? cur.viewOnceMessage?.message ?? cur.viewOnceMessageV2?.message ?? cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
};
const size = (n) => (n == null ? 0 : typeof n === "object" && "toNumber" in n ? n.toNumber() : Number(n)); // protobuf Long | number | string

/** @returns {{ok:true,eventId:string,from:string,type:'document'|'image'|'text',text?:string,filename:string,mimeType:string,size:number}|{ok:false,reason:string}} */
export function parseInbound(msg) {
  if (!msg?.key?.id || !msg.message) return { ok: false, reason: "empty" };
  if (msg.key.fromMe) return { ok: false, reason: "own" };
  const jid = msg.key.remoteJidAlt ?? msg.key.remoteJid ?? "";
  if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return { ok: false, reason: "not_direct" };
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  if (!m) return { ok: false, reason: "no_phone_number" }; // e.g. an @lid id with no phone-number alias: we cannot map it to a tenant
  const content = unwrap(msg.message);
  const doc = content?.documentMessage, img = content?.imageMessage;
  const text = content?.conversation ?? content?.extendedTextMessage?.text;
  if (typeof text === "string" && LINK_RE.test(text)) return { ok: true, eventId: msg.key.id, from: m[1], type: "text", text: text.trim().toUpperCase(), filename: "", mimeType: "", size: 0 }; // the ONLY text we forward: `LINK ABC123`
  if (doc) return { ok: true, eventId: msg.key.id, from: m[1], type: "document", filename: String(doc.fileName || "whatsapp-document").slice(0, 200), mimeType: String(doc.mimetype || ""), size: size(doc.fileLength) };
  if (img) return { ok: true, eventId: msg.key.id, from: m[1], type: "image", filename: "whatsapp-image", mimeType: String(img.mimetype || "image/jpeg"), size: size(img.fileLength) };
  return { ok: false, reason: "unsupported_type" };
}
