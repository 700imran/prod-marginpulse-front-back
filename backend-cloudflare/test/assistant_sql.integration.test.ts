// Runs the assistant's real SQL against a real Postgres loaded with
// db/schema.sql. Skipped unless PG_TEST_URL is set (CI stays hermetic):
//   PG_TEST_URL=postgres://postgres@localhost/mp npx vitest run test/assistant_sql
// The connection must be a role that is NOT a superuser/BYPASSRLS if you
// also want RLS exercised; here tenant scoping is asserted by the queries'
// own `tenant_id = $1` predicate.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { searchDocumentsByInvoiceOrVendor, listByGSTStatus } from "../src/repository/documents";
import { listAuditLog } from "../src/repository/auditLog";

const url = process.env.PG_TEST_URL;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const D1 = "d1d1d1d1-0000-0000-0000-000000000001", D2 = "d2d2d2d2-0000-0000-0000-000000000002", A1 = "a1a1a1a1-0000-0000-0000-000000000003", OTHER = "0e0e0e0e-0000-0000-0000-000000000004";

describe.skipIf(!url)("assistant SQL (real Postgres)", () => {
  const sql = postgres(url ?? "postgres://x", { max: 1 }) as any;

  async function doc(tenant: string, vendor: string, inv: string, gst: string, deleted = false, tax = 100) {
    await sql.unsafe(
      `insert into documents (tenant_id, original_filename, storage_key, mime_type, vendor_name, invoice_number, gst_portal_status, tax_amount, deleted_at)
       values ($1,'f.pdf','k','application/pdf',$2,$3,$4,$5,$6)`,
      [tenant, vendor, inv, gst, tax, deleted ? new Date() : null],
    );
  }

  beforeAll(async () => {
    await sql.unsafe(`delete from documents; delete from tenants; delete from auth.users`);
    for (const [id, e] of [[A, "a@x.in"], [B, "b@x.in"]]) {
      await sql.unsafe(`insert into auth.users (id, email) values ($1,$2) on conflict do nothing`, [id, e]);
      // (the on_auth_user_created trigger in schema.sql creates the tenants row)
    }
    await doc(A, "Acme Traders", "INV-204", "NOT_FILED");
    await doc(A, "100% Organic_Foods", "INV-1", "MISMATCH", false, 500);
    await doc(A, "Trashed Co", "INV-9", "NOT_FILED", true);
    await doc(B, "Acme Traders", "INV-204", "NOT_FILED");
  });
  afterAll(async () => { await sql.end(); });

  it("search is tenant-scoped, case-insensitive, excludes trash", async () => {
    const r = await searchDocumentsByInvoiceOrVendor(sql, A, "acme");
    expect(r).toHaveLength(1);
    expect(r[0]!.vendorName).toBe("Acme Traders");
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "trashed")).toHaveLength(0);
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "INV-204")).toHaveLength(1);
  });
  it("LIKE wildcards in the search term are literal", async () => {
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "%")).toHaveLength(1);        // only the vendor containing a literal %
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "_")).toHaveLength(1);        // only the vendor containing a literal _
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "A_me")).toHaveLength(0);     // _ must not match "c"
  });
  it("injection-looking input is just a string", async () => {
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "x'; drop table documents;--")).toHaveLength(0);
    expect(await searchDocumentsByInvoiceOrVendor(sql, A, "acme")).toHaveLength(1); // table still there
  });
  it("limit is capped at 10", async () => {
    for (let i = 0; i < 12; i++) await doc(A, "Bulk Vendor", `B-${i}`, "FILED");
    expect((await searchDocumentsByInvoiceOrVendor(sql, A, "bulk", 500)).length).toBe(10);
  });
  it("listByGSTStatus excludes trashed documents and other tenants", async () => {
    const r = await listByGSTStatus(sql, A, "NOT_FILED");
    expect(r.map((d: any) => d.vendorName)).toEqual(["Acme Traders"]);
  });

  it("listAuditLog: tenant-scoped, filterable, ordered newest first, limit clamped", async () => {
    await sql.unsafe(`delete from audit_log`);
    for (const [t, type, id] of [[A, "DOCUMENT", D1], [A, "ANOMALY", A1], [A, "DOCUMENT", D2], [B, "DOCUMENT", OTHER]]) {
      await sql.unsafe(`insert into audit_log (tenant_id, entity_type, entity_id, action, actor_email) values ($1,$2,$3,'X','x@x.in')`, [t, type, id]);
    }
    const all = await listAuditLog(sql, A);
    expect(all.map((r: any) => r.entityId).sort()).toEqual([A1, D1, D2].sort());   // never B's row
    expect((await listAuditLog(sql, A, { entityType: "DOCUMENT" })).length).toBe(2);
    expect((await listAuditLog(sql, A, { entityType: "DOCUMENT", entityId: D2 })).length).toBe(1);
    expect((await listAuditLog(sql, A, { limit: 1 })).length).toBe(1);
    expect((await listAuditLog(sql, A, { entityType: "x'; delete from audit_log;--" })).length).toBe(0);
    expect((await listAuditLog(sql, A)).length).toBe(3);                          // table intact
    expect((await listAuditLog(sql, A, { limit: 99999 })).length).toBe(3);        // clamped, not an error
  });
});
