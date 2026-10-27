// Tenant isolation guard: every SQL statement that touches a per-tenant table must
// carry a tenant_id predicate. A new query that forgets it fails this test, so
// cross-tenant data access (IDOR) can't be introduced silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TENANT_TABLES = ["documents", "bank_transactions", "tax_identifiers", "bank_accounts", "team_members", "anomalies", "audit_log", "reconciliation_settings", "notification_settings", "integration_settings", "integrations"];
// Intentionally global lookups, each keyed by an unguessable secret rather than a tenant id.
const ALLOW = [/where invite_token = \$1 and status = 'INVITED'/];

function walk(d: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p, out) : p.endsWith(".ts") && out.push(p); }
  return out;
}

// Extracts the full text of each sql`...` / sql.unsafe(`...` | "..." | '...') literal,
// correctly skipping ${ ... } interpolations (which may contain quotes and backticks).
function sqlLiterals(src: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  const opener = /sql(?:\.unsafe)?\s*(?:<[^>]*>)?\s*\(?\s*([`'"])/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src))) {
    const quote = m[1]!;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "\\") { i += 2; continue; }
      if (quote === "`" && ch === "$" && src[i + 1] === "{") {
        let depth = 1; i += 2;
        while (i < src.length && depth > 0) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
        continue;
      }
      if (ch === quote) break;
      i++;
    }
    out.push({ text: src.slice(start, i), index: m.index });
    opener.lastIndex = i + 1;
  }
  return out;
}

test("every query on a per-tenant table is scoped by tenant_id", () => {
  const offenders: string[] = [];
  let inspected = 0;
  for (const file of walk("src")) {
    const src = fs.readFileSync(file, "utf8");
    for (const { text: q, index } of sqlLiterals(src)) {
      if (!/\b(select|update|delete|insert)\b/i.test(q)) continue;
      inspected++;
      const touches = TENANT_TABLES.filter((t) => new RegExp(`\\b(from|into|update|join)\\s+(public\\.)?${t}\\b`, "i").test(q));
      if (touches.length && !/tenant_id/i.test(q) && !ALLOW.some((a) => a.test(q))) {
        offenders.push(`${file}:${src.slice(0, index).split("\n").length} [${touches}] ${q.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  assert.ok(inspected > 40, `scanner only found ${inspected} queries — tokenizer broken?`);
  assert.deepEqual(offenders, [], "queries missing tenant_id:\n" + offenders.join("\n"));
});
