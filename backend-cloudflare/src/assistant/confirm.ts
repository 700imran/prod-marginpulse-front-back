// Signed, short-lived, single-use confirmation tokens for assistant
// actions that change data (see WORKFLOW.md, "Confirmation flow").
//
// Why a token and not "the user said yes in the next message": a free-text
// "yes" would have to be interpreted by the model again, which is exactly
// the trust-the-LLM mistake this whole design exists to avoid — and text a
// vendor name smuggled into the conversation could say "yes" too. The
// token is minted by the Worker only after it has validated the proposed
// action itself, and is redeemed through a distinct endpoint.
//
// A token binds: which tenant, which action, the exact (already validated)
// arguments, an expiry, and a random nonce. It is HMAC-signed with a key
// derived from FIELD_ENCRYPTION_KEY under its own context label, so
// signatures are not interchangeable with signed download links
// (storage.ts), and it is single-use: the nonce is consumed in Redis
// (SET NX) before the action runs, so a replayed token does nothing.
import type { Env } from "../config";
import { upstash } from "../ratelimit";

export const CONFIRM_TTL_SECONDS = 300;
const CONTEXT_LABEL = "marginpulse/assistant-confirm/v1";

export interface ConfirmPayload {
  v: 1;
  tid: string; // tenant id
  act: string; // action (tool) name
  args: Record<string, unknown>;
  exp: number; // unix seconds
  nonce: string;
}

export type VerifyResult =
  | { ok: true; payload: ConfirmPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "WRONG_TENANT" };

type KeyEnv = Pick<Env, "FIELD_ENCRYPTION_KEY">;

const enc = new TextEncoder();

async function derivedKey(env: KeyEnv): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", enc.encode(env.FIELD_ENCRYPTION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const subkeyBytes = await crypto.subtle.sign("HMAC", master, enc.encode(CONTEXT_LABEL));
  return crypto.subtle.importKey("raw", subkeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) return null;
  try {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function signConfirmToken(
  env: KeyEnv,
  tenantId: string,
  action: string,
  args: Record<string, unknown>,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; exp: number; nonce: string }> {
  const nonce = crypto.randomUUID();
  const exp = now + CONFIRM_TTL_SECONDS;
  const payload: ConfirmPayload = { v: 1, tid: tenantId, act: action, args, exp, nonce };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await derivedKey(env), enc.encode(body)));
  return { token: `${body}.${b64urlEncode(sig)}`, exp, nonce };
}

export async function verifyConfirmToken(
  env: KeyEnv,
  token: string,
  expectedTenantId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "MALFORMED" };
  const [body, sig] = parts as [string, string];
  const sigBytes = b64urlDecode(sig);
  if (!sigBytes) return { ok: false, reason: "MALFORMED" };

  // crypto.subtle.verify is a constant-time comparison.
  const valid = await crypto.subtle.verify("HMAC", await derivedKey(env), sigBytes, enc.encode(body));
  if (!valid) return { ok: false, reason: "BAD_SIGNATURE" };

  const bodyBytes = b64urlDecode(body);
  if (!bodyBytes) return { ok: false, reason: "MALFORMED" };
  let payload: ConfirmPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as ConfirmPayload;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (
    payload.v !== 1 || typeof payload.tid !== "string" || typeof payload.act !== "string" ||
    typeof payload.exp !== "number" || typeof payload.nonce !== "string" ||
    typeof payload.args !== "object" || payload.args === null || Array.isArray(payload.args)
  ) return { ok: false, reason: "MALFORMED" };

  if (now > payload.exp) return { ok: false, reason: "EXPIRED" };
  if (payload.tid !== expectedTenantId) return { ok: false, reason: "WRONG_TENANT" };
  return { ok: true, payload };
}

// Single-use enforcement. Returns true exactly once per nonce. Throws if
// Redis is unreachable — callers must treat that as "do not execute"
// (fail closed): an action that changes data must never run without being
// able to record that its token was spent.
export async function consumeConfirmNonce(env: Env, nonce: string): Promise<boolean> {
  const result = await upstash(env, "SET", `assistant_confirm:${nonce}`, "1", "NX", "EX", CONFIRM_TTL_SECONDS * 2);
  return result === "OK";
}
