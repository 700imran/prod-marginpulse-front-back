// The scale indexes (db/005_scale_indexes.sql, mirrored in schema.sql) exist, are idempotent, and the PARTIAL foreign-key indexes
// are actually usable by the lookups Postgres runs for foreign-key checks. Needs TEST_DATABASE_URL.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness;
const keepAlive = setInterval(() => {}, 1000);
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { clearInterval(keepAlive); if (h) await h.close(); });

const EXPECTED = [
  "idx_documents_duplicate_of", "idx_documents_matched_tx", "idx_banktx_matched_document", "idx_anomalies_document",
  "idx_anomalies_related_tx", "idx_documents_tenant_vendor_invoice", "idx_banktx_tenant_created",
];

test("every scale index from 005_scale_indexes.sql is in schema.sql (a fresh install gets them) and was created", { skip }, async () => {
  const rows = await h.admin<{ indexname: string }[]>`select indexname from pg_indexes where schemaname = 'public'`;
  const have = new Set(rows.map((r) => r.indexname));
  for (const name of EXPECTED) assert.ok(have.has(name), `${name} missing from the schema`);
  const migration = readFileSync(new URL("../db/005_scale_indexes.sql", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  for (const name of EXPECTED) { assert.ok(migration.includes(name), `${name} missing from the migration`); assert.ok(schema.includes(name), `${name} not mirrored in schema.sql`); }
});

test("the migration is idempotent (safe to run again on a database that already has the indexes)", { skip }, async () => {
  const migration = readFileSync(new URL("../db/005_scale_indexes.sql", import.meta.url), "utf8");
  const statements = migration.split("\n").filter((l) => l.startsWith("create index"));
  assert.equal(statements.length, EXPECTED.length);
  for (const stmt of statements) await h.admin.unsafe(stmt); // "if not exists" → no error, no duplicate index
});

// The lookups Postgres issues for foreign keys are `select 1 from <child> where <fk col> = $1`. A partial index
// (`where col is not null`) must be provable-usable for an equality test, otherwise the index would never be chosen.
// With sequential scans disabled the only index that can answer the query is the new one.
for (const [table, column, index] of [
  ["documents", "duplicate_of_document_id", "idx_documents_duplicate_of"],
  ["documents", "matched_bank_transaction_id", "idx_documents_matched_tx"],
  ["bank_transactions", "matched_document_id", "idx_banktx_matched_document"],
  ["anomalies", "document_id", "idx_anomalies_document"],
  ["anomalies", "related_transaction_id", "idx_anomalies_related_tx"],
] as const) {
  test(`foreign-key lookup on ${table}.${column} can use ${index}`, { skip }, async () => {
    const plan = await h.admin.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_bitmapscan = off`;
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`explain select 1 from public.${table} where ${column} = '00000000-0000-0000-0000-000000000001'::uuid`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    assert.match(plan, new RegExp(index), plan);
  });
}

// ── N+1 removal: GST portal sync wrote one UPDATE per invoice; now one per distinct status ──
import { getDb } from "../src/db.ts";
import { setGstPortalStatuses } from "../src/repository/documents.ts";

test("setGstPortalStatuses updates each status group in one statement (chunked), only inside the given tenant", { skip }, async () => {
  const a = await h.newTenant("gst-a"), b = await h.newTenant("gst-b");
  const mk = async (t: { tenantId: string }, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [r] = await h.admin<{ id: string }[]>`insert into documents (tenant_id, original_filename, storage_key, mime_type, vendor_name, tax_identifier)
        values (${t.tenantId}, 'a.pdf', ${"k/" + t.tenantId + "/" + i}, 'application/pdf', 'V', '27ABCDE1234F1Z5') returning document_id as id`;
      ids.push(r!.id);
    }
    return ids;
  };
  const aIds = await mk(a, 7), bIds = await mk(b, 2);
  const sql = getDb(h.env);
  try {
    const byStatus = new Map<string, string[]>([["FILED", aIds.slice(0, 4)], ["MISMATCH", aIds.slice(4, 6)], ["NOT_FILED", [aIds[6]!, bIds[0]!]]]); // bIds[0] belongs to tenant B: must be ignored
    const n = await setGstPortalStatuses(sql, a.tenantId, byStatus, 3); // chunk of 3 forces FILED to span two statements
    assert.equal(n, 7, "all seven of tenant A's documents updated; the foreign id is not counted");
    assert.equal(await setGstPortalStatuses(sql, a.tenantId, new Map()), 0, "nothing to do is fine");
  } finally { await sql.end(); }
  const rows = await h.admin<{ id: string; s: string }[]>`select document_id as id, gst_portal_status as s from documents where tenant_id = ${a.tenantId}`;
  const st = new Map(rows.map((r) => [r.id, r.s]));
  assert.deepEqual(aIds.map((id) => st.get(id)), ["FILED", "FILED", "FILED", "FILED", "MISMATCH", "MISMATCH", "NOT_FILED"]);
  const other = await h.admin<{ s: string }[]>`select gst_portal_status as s from documents where tenant_id = ${b.tenantId}`;
  assert.ok(other.every((r) => r.s === "PENDING"), "tenant B untouched");
});
