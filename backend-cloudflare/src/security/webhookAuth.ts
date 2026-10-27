// Constant-time secret comparison that also hides the secret's length
// (compares SHA-256 digests, so inputs are always the same size).
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// Only Meta-owned hosts may be fetched when downloading WhatsApp media (SSRF guard).
const MEDIA_HOST_SUFFIXES = [".facebook.com", ".fbcdn.net", ".fbsbx.com", ".whatsapp.net", ".whatsapp.com"];
export function isTrustedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && MEDIA_HOST_SUFFIXES.some((s) => u.hostname === s.slice(1) || u.hostname.endsWith(s));
  } catch { return false; }
}
