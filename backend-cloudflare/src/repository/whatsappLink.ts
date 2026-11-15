import type { Sql } from "../db";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const LINK_TTL_MINUTES = 15;
export const LINK_TEXT_RE = /^\s*LINK\s+([A-Za-z0-9]{6})\s*$/i;

async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const newCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => ALPHABET[b % ALPHABET.length]).join("");

/** One live code per tenant: asking again replaces the previous one. */
export async function createLinkCode(sql: Sql, tenantId: string): Promise<string> {
  const code = newCode();
  await sql`delete from whatsapp_link_codes where tenant_id = ${tenantId}`;
  await sql`insert into whatsapp_link_codes (code_hash, tenant_id, expires_at) values (${await sha256Hex(code)}, ${tenantId}, now() + make_interval(mins => ${LINK_TTL_MINUTES}))`;
  return code;
}

/** Atomic: consumes the code and binds the number in ONE statement. A number already bound elsewhere leaves the code intact. */
export async function consumeLinkCode(sql: Sql, code: string, phone: string): Promise<{ ok: true; tenantId: string } | { ok: false; reason: "invalid" | "conflict" }> {
  const hash = await sha256Hex(code.toUpperCase());
  try {
    const rows = await sql<{ tenantId: string }[]>`
      with c as (delete from whatsapp_link_codes where code_hash = ${hash} and expires_at > now() returning tenant_id)
      update tenants t set whatsapp_binding_phone = ${phone}, updated_at = now() from c where t.tenant_id = c.tenant_id returning t.tenant_id as "tenantId"`;
    return rows[0] ? { ok: true, tenantId: rows[0].tenantId } : { ok: false, reason: "invalid" };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, reason: "conflict" };
    throw e;
  }
}

export async function getBoundPhone(sql: Sql, tenantId: string): Promise<string | null> {
  const r = await sql<{ p: string | null }[]>`select whatsapp_binding_phone as p from tenants where tenant_id = ${tenantId}`;
  return r[0]?.p ?? null;
}
export async function unbindPhone(sql: Sql, tenantId: string): Promise<void> {
  await sql`update tenants set whatsapp_binding_phone = null, updated_at = now() where tenant_id = ${tenantId}`;
  await sql`delete from whatsapp_link_codes where tenant_id = ${tenantId}`;
}
export const maskPhone = (p: string) => `+${p.slice(0, 2)}${"•".repeat(Math.max(0, p.length - 6))}${p.slice(-4)}`;
