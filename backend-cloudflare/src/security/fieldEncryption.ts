import type { Env } from "../config";

// Replaces internal/security/fieldencryption.go. Same scheme: AES-256-GCM,
// random 12-byte nonce prepended to the ciphertext, base64 for storage.
// Used for bank_accounts.account_number_encrypted and any encrypted
// integration tokens.

async function importKey(env: Env): Promise<CryptoKey> {
  const raw = base64ToBytes(env.FIELD_ENCRYPTION_KEY);
  if (raw.length !== 32) {
    throw new Error("FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptField(env: Env, plaintext: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

export async function decryptField(env: Env, encoded: string): Promise<string> {
  const key = await importKey(env);
  const combined = base64ToBytes(encoded);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export function last4(accountNumber: string): string {
  return accountNumber.replace(/\s/g, "").slice(-4);
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
