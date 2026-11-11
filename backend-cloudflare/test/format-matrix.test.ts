// Accuracy matrix: every bank-statement layout × every invoice-register layout, with ground truth.
//  1. PARSE FIDELITY — each row must come out of normaliseDataset with the right date, amount, party.
//  2. RECONCILE ACCURACY — auto-approved matches must be 100% correct; true matches must be found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseDataset } from "../src/pipelines/dataset.ts";
import { reconcileBatch } from "../src/pipelines/reconciliation.ts";
import { makeLedger, BANK_LAYOUTS, INVOICE_LAYOUTS, r2, type Bk, type Inv } from "./helpers/corpus.ts";

const ledger = makeLedger({ n: 120, seed: 7, unpaid: 0.15, tds: 0.15, lateMax: 30, debitNotes: 0.05 });

const bankKey = (d: string, debit: number, credit: number, n: string) => `${d}|${r2(debit)}|${r2(credit)}|${n.trim()}`;

for (const layout of BANK_LAYOUTS) {
  test(`bank parse fidelity — ${layout.name}`, () => {
    const grid = layout.render(ledger.bank);
    const d = normaliseDataset(grid);
    assert.ok(d, "header/columns not detected");
    assert.equal(d.datasetType, "BANK_STATEMENT");
    const want = new Map<string, number>(); const got = new Map<string, number>();
    for (const b of ledger.bank) { const k = bankKey(b.date, b.debit, b.credit, b.narration); want.set(k, (want.get(k) ?? 0) + 1); }
    for (const b of d.bank) { const k = bankKey(b.date, b.debit, b.credit, b.narration); got.set(k, (got.get(k) ?? 0) + 1); }
    const missing = [...want.keys()].filter((k) => (got.get(k) ?? 0) < want.get(k)!);
    const extra = [...got.keys()].filter((k) => (want.get(k) ?? 0) < got.get(k)!);
    assert.deepEqual({ missing: missing.slice(0, 3), extra: extra.slice(0, 3), n: d.bank.length }, { missing: [], extra: [], n: ledger.bank.length });
  });
}

for (const layout of INVOICE_LAYOUTS) {
  test(`invoice parse fidelity — ${layout.name}`, () => {
    const d = normaliseDataset(layout.render(ledger.invoices));
    assert.ok(d, "header/columns not detected");
    assert.ok(d.datasetType === "INVOICE_REGISTER" || d.datasetType === "GST_RETURN", `classified as ${d.datasetType}`);
    assert.equal(d.invoices.length, ledger.invoices.length, `row count (${d.warnings.join("; ")})`);
    const byNo = new Map(d.invoices.map((x) => [x.invoiceNo, x]));
    const bad: string[] = [];
    for (const i of ledger.invoices) {
      const g = byNo.get(i.no);
      if (!g) { bad.push(`${i.no}: missing`); continue; }
      if (g.date !== i.date) bad.push(`${i.no}: date ${g.date} != ${i.date}`);
      if (Math.abs(g.total - i.total) > 0.01) bad.push(`${i.no}: total ${g.total} != ${i.total}`);
      if (g.vendor.trim().toLowerCase() !== i.vendor.toLowerCase()) bad.push(`${i.no}: vendor ${g.vendor}`);
      if (layout.keepsGstin && g.gstin !== i.gstin) bad.push(`${i.no}: gstin ${g.gstin} != ${i.gstin}`);
      if (layout.hasTaxSplit && Math.abs(g.tax - i.tax) > 0.02) bad.push(`${i.no}: tax ${g.tax} != ${i.tax}`);
      if (layout.name.startsWith("Tally") && g.docType !== (i.kind === "DEBIT_NOTE" ? "CREDIT_NOTE" : "INVOICE")) bad.push(`${i.no}: docType ${g.docType}`);
    }
    assert.deepEqual(bad.slice(0, 5), []);
  });
}

// ── reconciliation accuracy over the full cross product ────────────────────
function toEngine(inv: ReturnType<typeof normaliseDataset>, bank: ReturnType<typeof normaliseDataset>) {
  const invoices = inv!.invoices.filter((i) => i.docType !== "CREDIT_NOTE").map((i) => ({ documentId: i.invoiceNo, vendorName: i.vendor, rawTotalAmount: i.total, documentDate: i.date, invoiceNumber: i.invoiceNo }));
  const rows = bank!.bank.map((b, k) => ({ transactionId: `row${k}|${b.date}|${b.debit}|${b.narration}`, narration: b.narration, debitAmount: b.debit, transactionDate: b.date }));
  return { invoices, rows };
}

test("reconcile accuracy: every bank layout × every invoice layout (auto-approvals 100% correct, matches found)", () => {
  const rows: string[] = []; let totalAuto = 0, totalWrong = 0, totalMatchable = 0, totalFound = 0, totalCandidates = 0, totalExact = 0, totalExactFound = 0;
  const bankByKey = new Map<string, Bk>(); for (const b of ledger.bank) bankByKey.set(`${b.date}|${b.debit}|${b.narration}`, b);
  for (const bl of BANK_LAYOUTS) for (const il of INVOICE_LAYOUTS) {
    const bank = normaliseDataset(bl.render(ledger.bank)); const inv = normaliseDataset(il.render(ledger.invoices));
    if (!bank || !inv) { rows.push(`${bl.name} × ${il.name}: NOT PARSED`); continue; }
    const { invoices, rows: br } = toEngine(inv, bank);
    const res = reconcileBatch(invoices, br);
    let auto = 0, wrong = 0, matchable = 0, found = 0, cand = 0;
    for (const m of res) {
      const truthId = ledger.truth.get(m.documentId) ?? null;
      const truthBank = truthId ? ledger.bank.find((b) => b.id === truthId)! : null;
      const exactPair = !!truthBank && Math.abs(truthBank.debit - (ledger.invoices.find((x) => x.no === m.documentId)?.total ?? 0)) <= 1;
      if (truthBank) matchable++;
      if (exactPair) totalExact++;
      const matchedKey = m.matchedBankTransactionId?.split("|").slice(1).join("|");
      const truthKey = truthBank ? `${truthBank.date}|${truthBank.debit}|${truthBank.narration}` : null;
      if (m.status === "RECONCILED") { auto++; if (matchedKey !== truthKey) { wrong++; rows.push(`WRONG AUTO ${bl.name.slice(0, 12)} × ${il.name.slice(0, 12)}: ${m.documentId} -> ${matchedKey} (truth ${truthKey})`); } else { found++; if (exactPair) totalExactFound++; } }
      else if (truthBank && m.candidateBankTransactionId?.split("|").slice(1).join("|") === truthKey) cand++;
    }
    totalAuto += auto; totalWrong += wrong; totalMatchable += matchable; totalFound += found; totalCandidates += cand;
  }
  const recall = totalExactFound / totalExact; const recallWithReview = (totalFound + totalCandidates) / totalMatchable;
  console.log(`  matrix: ${BANK_LAYOUTS.length} bank × ${INVOICE_LAYOUTS.length} invoice layouts — auto ${totalAuto}, wrong ${totalWrong}, auto-recall on exact-amount payments ${(recall * 100).toFixed(1)}%, recall incl. review candidates (net-of-TDS etc.) ${(recallWithReview * 100).toFixed(1)}%`);
  assert.deepEqual(rows.filter((r) => r.startsWith("NOT PARSED") || r.startsWith("WRONG")).slice(0, 8), []);
  assert.equal(totalWrong, 0);
  assert.ok(recall >= 0.95, `auto recall on exact-amount payments ${recall}`);
  assert.ok(recallWithReview >= 0.97, `recall incl. review ${recallWithReview}`);
});
