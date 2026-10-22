// Keeps the schema check honest: its lists must match db/schema.sql, and (when a
// real Postgres is available) it must actually notice a missing table/column.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { checkSchema, REQUIRED_TABLES, REQUIRED_COLUMNS } from "../src/schemaCheck";

const schema = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");

describe("required schema lists match db/schema.sql", () => {
  it.each([...REQUIRED_TABLES])("table %s is defined in schema.sql", (t) => {
    expect(schema).toMatch(new RegExp(`create table if not exists (public\\.)?${t}\\b`));
  });
  it.each([...REQUIRED_COLUMNS])("column %s.%s is defined in schema.sql", (t, c) => {
    const inCreate = new RegExp(`create table if not exists (public\\.)?${t}\\s*\\([\\s\\S]*?\\b${c}\\b[\\s\\S]*?\\n\\);`).test(schema);
    const inAlter = new RegExp(`alter table (public\\.)?${t} add column if not exists ${c}\\b`).test(schema);
    expect(inCreate || inAlter).toBe(true);
  });
});

describe("checkSchema against a fake that reports everything present / missing", () => {
  const fake = (row: Record<string, boolean>) => ({ unsafe: async () => [row] }) as any;
  const all = () => Object.fromEntries([...REQUIRED_TABLES.map((_, i) => [`t${i}`, true]), ...REQUIRED_COLUMNS.map((_, i) => [`c${i}`, true]), ["rls", true]]);
  it("ok when everything is present", async () => {
    expect(await checkSchema(fake(all()))).toEqual({ ok: true, missing: [], rlsEnabled: true });
  });
  it("names exactly what's missing", async () => {
    const r = all(); r.t7 = false; r.c0 = false;
    const s = await checkSchema(fake(r));
    expect(s.ok).toBe(false);
    expect(s.missing).toEqual([REQUIRED_TABLES[7], "documents.deleted_at"]);
  });
  it("RLS off is reported but doesn't fail the schema check", async () => {
    const r = all(); r.rls = false;
    expect(await checkSchema(fake(r))).toEqual({ ok: true, missing: [], rlsEnabled: false });
  });
});

const url = process.env.PG_TEST_URL;
describe.skipIf(!url)("checkSchema against real Postgres loaded with db/schema.sql", () => {
  const sql = postgres(url ?? "postgres://x", { max: 1 }) as any;
  afterAll(async () => { await sql.end(); });
  it("passes on the real schema", async () => {
    const s = await checkSchema(sql);
    expect(s.missing).toEqual([]);
    expect(s.ok).toBe(true);
    expect(s.rlsEnabled).toBe(true);
  });
  it("detects a missing table and a missing column, then recovers", async () => {
    await sql.unsafe(`alter table public.credit_ledger rename to credit_ledger_gone`);
    await sql.unsafe(`alter table public.documents rename column deleted_at to deleted_at_gone`);
    try {
      const s = await checkSchema(sql);
      expect(s.ok).toBe(false);
      expect(s.missing.sort()).toEqual(["credit_ledger", "documents.deleted_at"]);
    } finally {
      await sql.unsafe(`alter table public.credit_ledger_gone rename to credit_ledger`);
      await sql.unsafe(`alter table public.documents rename column deleted_at_gone to deleted_at`);
    }
    expect((await checkSchema(sql)).ok).toBe(true);
  });
});
