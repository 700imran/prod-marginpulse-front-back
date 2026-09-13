import type { Env } from "./config";

// Replaces internal/storage/storage.go. storage.go was already written
// against an endpoint-overridable S3 client "required by R2 and most
// non-AWS S3-compatible providers" (its own comment) — so if you ever
// need to run the Go binary against R2 as an interim step, pointing
// S3_ENDPOINT_URL at R2's S3-compatible endpoint works with zero code
// changes there. This file is the *native* R2-binding version for once
// everything is on Workers: no request signing, no egress fee.

export async function uploadBytes(
  env: Env,
  key: string,
  data: ArrayBuffer | ReadableStream,
  contentType: string,
): Promise<void> {
  await env.DOCS_BUCKET.put(key, data, {
    httpMetadata: { contentType },
  });
}

export async function downloadBytes(env: Env, key: string): Promise<ArrayBuffer | null> {
  const obj = await env.DOCS_BUCKET.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.DOCS_BUCKET.delete(key);
}

export function buildStorageKey(tenantId: string, documentId: string, originalFilename: string): string {
  const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  return `${tenantId}/${documentId}/${safeName}`;
}

// --- Signed download links -------------------------------------------------
// R2 bucket *bindings* (as opposed to the S3-compatible API) don't have a
// presigned-URL concept, so the idiomatic Workers replacement is: sign a
// short-lived token ourselves and verify it on a dedicated route
// (`GET /api/v1/documents/:id/download?token=...&exp=...`) that streams the
// R2 object straight through. Same net effect as
// storage.go's GetPresignedDownloadURL, one HTTP hop instead of a redirect.

async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signDownloadToken(env: Env, storageKey: string, expiresInSeconds = 300): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const key = await hmacKey(env.FIELD_ENCRYPTION_KEY);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${storageKey}.${exp}`));
  const token = base64UrlEncode(new Uint8Array(sig));
  return { token, exp };
}

export async function verifyDownloadToken(env: Env, storageKey: string, token: string, exp: number): Promise<boolean> {
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const key = await hmacKey(env.FIELD_ENCRYPTION_KEY);
  const expectedSig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${storageKey}.${exp}`));
  const expectedToken = base64UrlEncode(new Uint8Array(expectedSig));
  return timingSafeEqual(token, expectedToken);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
