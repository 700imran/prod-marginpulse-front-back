// HMAC-SHA256 verification for Meta's X-Hub-Signature-256 webhook
// header (WhatsApp Cloud API). Uses crypto.subtle.verify rather than a
// hand-rolled comparison, so the byte comparison is constant-time.

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function verifyMetaSignature256(appSecret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const sigBytes = hexToBytes(signatureHeader.slice(7));
  if (!sigBytes) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(rawBody));
}
