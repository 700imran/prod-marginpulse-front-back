// Identical invoices (same vendor, same amount — rent, retainers, repeat orders) are the one case where amount + vendor
// + date cannot prove which payment settles which invoice. The engine must not guess: those go to a human, with the
// best candidate attached. A decisive invoice-number reference in the narration still auto-approves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileBatch } from "../src/pipelines/reconciliation.ts";
import { makeLedger, BANK_LAYOUTS, INVOICE_LAYOUTS } from "./helpers/corpus.ts";
import { normaliseDataset } from "../src/pipelines/dataset.ts";

const inv = (id: string, date: string, vendor = "ACME TRADERS PVT LTD", amt = 50000) => ({ documentId: id, vendorName: vendor, rawTotalAmount: amt, documentDate: date, invoiceNumber: id });
const pay = (id: string, date: string, narration: string, amt = 50000) => ({ transactionId: id, narration, debitAmount: amt, transactionDate: date });
const by = (res: ReturnType<typeof reconcileBatch>) => Object.fromEntries(res.map((r) => [r.documentId, r]));

test("two identical invoices, two identical payments, no invoice number in narration → both need review (no guessing by date)", () => {
  const r = by(reconcileBatch([inv("INV-1001", "2026-04-01"), inv("INV-1002", "2026-04-20")], [pay("p1", "2026-04-12", "NEFT-ACME TRADERS PVT LTD"), pay("p2", "2026-05-02", "NEFT-ACME TRADERS PVT LTD")]));
  assert.equal(r["INV-1001"]!.status, "MANUAL_REVIEW"); assert.equal(r["INV-1002"]!.status, "MANUAL_REVIEW");
  assert.ok(r["INV-1001"]!.candidateBankTransactionId, "a suggestion is still attached for the reviewer");
});

test("one payment, two identical open invoices → review, not a coin flip", () => {
  const r = by(reconcileBatch([inv("INV-1001", "2026-04-01"), inv("INV-1002", "2026-04-20")], [pay("p1", "2026-04-25", "NEFT-ACME TRADERS PVT LTD")]));
  assert.equal(Object.values(r).filter((x) => x.status === "RECONCILED").length, 0);
});

test("invoice numbers in the narrations are decisive — identical amounts still reconcile, to the right payment", () => {
  const r = by(reconcileBatch([inv("INV-1001", "2026-04-01"), inv("INV-1002", "2026-04-20")], [pay("p1", "2026-05-02", "NEFT-ACME TRADERS PVT LTD-INV-1001"), pay("p2", "2026-04-25", "NEFT-ACME TRADERS PVT LTD-INV-1002")]));
  assert.equal(r["INV-1001"]!.status, "RECONCILED"); assert.equal(r["INV-1001"]!.matchedBankTransactionId, "p1");
  assert.equal(r["INV-1002"]!.status, "RECONCILED"); assert.equal(r["INV-1002"]!.matchedBankTransactionId, "p2");
});

test("an invoice-number hit elsewhere clears the ambiguity for the other invoice", () => {
  const r = by(reconcileBatch([inv("INV-1001", "2026-04-01"), inv("INV-1002", "2026-04-20")], [pay("p1", "2026-04-12", "NEFT-ACME TRADERS PVT LTD-INV-1001"), pay("p2", "2026-05-02", "NEFT-ACME TRADERS PVT LTD")]));
  assert.equal(r["INV-1001"]!.matchedBankTransactionId, "p1");
  assert.equal(r["INV-1002"]!.status, "RECONCILED"); assert.equal(r["INV-1002"]!.matchedBankTransactionId, "p2"); // p1 is provably A-1's, so p2 can only be A-2's
});

test("no regression: a single invoice and a single payment still auto-reconcile", () => {
  const r = by(reconcileBatch([inv("INV-1001", "2026-04-01")], [pay("p1", "2026-04-12", "NEFT-ACME TRADERS PVT LTD")]));
  assert.equal(r["INV-1001"]!.status, "RECONCILED");
});

test("same amount to a DIFFERENT payee is not a rival", () => {
  const r = by(reconcileBatch([inv("INV-1001", "2026-04-01")], [pay("p1", "2026-04-12", "NEFT-ACME TRADERS PVT LTD"), pay("p2", "2026-04-13", "UPI-RANDOM LANDLORD SERVICES")]));
  assert.equal(r["INV-1001"]!.status, "RECONCILED"); assert.equal(r["INV-1001"]!.matchedBankTransactionId, "p1");
});

test("adversarial sweep (round, repeated amounts × 3 narration styles × 6 seeds × layouts): ZERO wrong auto-approvals", () => {
  let auto = 0, wrong = 0; const bad: string[] = [];
  for (const style of ["full", "short", "mixed"] as const) for (let seed = 1; seed <= 6; seed++) {
    const L = makeLedger({ n: 120, seed, unpaid: 0.15, tds: 0.1, lateMax: 30, debitNotes: 0.03, narrationStyle: style, roundAmounts: true });
    for (const [bi, ii] of [[0, 0], [3, 1], [5, 3], [10, 5], [7, 6]] as const) {
      const bank = normaliseDataset(BANK_LAYOUTS[bi]!.render(L.bank))!; const invs = normaliseDataset(INVOICE_LAYOUTS[ii]!.render(L.invoices))!;
      const invoices = invs.invoices.filter((i) => i.docType !== "CREDIT_NOTE").map((i) => ({ documentId: i.invoiceNo, vendorName: i.vendor, rawTotalAmount: i.total, documentDate: i.date, invoiceNumber: i.invoiceNo }));
      const rows = bank.bank.map((b, k) => ({ transactionId: `row${k}|${b.date}|${b.debit}|${b.narration}`, narration: b.narration, debitAmount: b.debit, transactionDate: b.date }));
      for (const m of reconcileBatch(invoices, rows)) {
        if (m.status !== "RECONCILED") continue;
        auto++;
        const tid = L.truth.get(m.documentId) ?? null; const tb = tid ? L.bank.find((b) => b.id === tid)! : null;
        const key = m.matchedBankTransactionId!.split("|").slice(1).join("|");
        if (!tb || key !== `${tb.date}|${tb.debit}|${tb.narration}`) { wrong++; if (bad.length < 5) bad.push(`${style}/${seed} b${bi} i${ii} ${m.documentId} -> ${key}`); }
      }
    }
  }
  console.log(`  adversarial: ${auto} auto-approvals, ${wrong} wrong`);
  assert.deepEqual(bad, []); assert.equal(wrong, 0);
  assert.ok(auto > 500, `engine must still auto-approve the unambiguous ones (got ${auto})`);
});
