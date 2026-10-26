// Accuracy benchmark: legacy (soft-amount, independent) vs v2 (gated, one-to-one)
// on synthetic datasets with known ground truth. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileBatch, reconcileBatchLegacy, type Invoice, type BankRow } from "../src/pipelines/reconciliation.ts";

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const VENDORS = ["Acme Traders Pvt Ltd", "Sharma Steel Works", "Bharat Packaging Co", "Kiran Logistics LLP", "Om Sai Enterprises", "Delta Office Supplies", "Patel Chemicals Ltd", "Greenfield Agro Pvt Ltd", "Sunrise Electricals", "Vikram Textiles", "Nova Print Solutions", "Rajdhani Foods Ltd"];
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

interface Scenario { name: string; n: number; payDelay: [number, number]; noise: "clean" | "bank" | "abbrev"; tdsShare: number; unpaidShare: number; sameAmount: boolean; wrongAmountDecoys: boolean }

function build(sc: Scenario, seed: number) {
  const r = rng(seed);
  const invoices: Invoice[] = []; const bank: BankRow[] = []; const truth = new Map<string, string | null>();
  for (let i = 0; i < sc.n; i++) {
    const vendor = VENDORS[Math.floor(r() * VENDORS.length)]!;
    const amount = sc.sameAmount ? [10000, 25000, 50000][Math.floor(r() * 3)]! : Math.round((2000 + r() * 90000) * 100) / 100;
    const date = addDays("2026-04-01", Math.floor(r() * 60));
    const id = `inv${i}`; const invNo = `INV-${1000 + i}`;
    invoices.push({ documentId: id, vendorName: vendor, rawTotalAmount: amount, documentDate: date, invoiceNumber: invNo });
    if (r() < sc.unpaidShare) {
      truth.set(id, null);
      if (sc.wrongAmountDecoys) bank.push({ transactionId: `decoy${i}`, narration: `NEFT-${vendor.toUpperCase()}-REF${Math.floor(r() * 1e8)}`, debitAmount: Math.round(amount * 1.06 * 100) / 100, transactionDate: addDays(date, 3) });
      continue;
    }
    let paid = amount; if (r() < sc.tdsShare) paid = Math.round(amount * 0.98 * 100) / 100;
    const delay = sc.payDelay[0] + Math.floor(r() * (sc.payDelay[1] - sc.payDelay[0] + 1));
    let narration = vendor;
    if (sc.noise !== "clean") {
      const base = sc.noise === "abbrev" ? vendor.split(" ").slice(0, 2).join(" ").slice(0, 12) : vendor;
      narration = `NEFT-HDFC000${Math.floor(r() * 9)}-${base.toUpperCase()}-REF${Math.floor(r() * 1e9)}${r() < 0.4 ? " " + invNo : ""}`;
    }
    const tid = `tx${i}`; truth.set(id, tid);
    bank.push({ transactionId: tid, narration, debitAmount: paid, transactionDate: addDays(date, delay) });
  }
  for (let k = 0; k < sc.n / 3; k++) bank.push({ transactionId: `noise${k}`, narration: `UPI-${VENDORS[Math.floor(r() * VENDORS.length)]!.toUpperCase()}-MISC`, debitAmount: Math.round((500 + r() * 80000) * 100) / 100, transactionDate: addDays("2026-04-01", Math.floor(r() * 90)) });
  return { invoices, bank, truth };
}

function score(results: ReturnType<typeof reconcileBatch>, truth: Map<string, string | null>) {
  let auto = 0, autoCorrect = 0, wrongAuto = 0, matchable = 0, found = 0, falseOnUnpaid = 0, unpaid = 0, review = 0;
  for (const m of results) {
    const t = truth.get(m.documentId) ?? null;
    if (t) matchable++; else unpaid++;
    if (m.status === "RECONCILED") { auto++; if (m.matchedBankTransactionId === t) { autoCorrect++; if (t) found++; } else { wrongAuto++; if (!t) falseOnUnpaid++; } }
    if (m.status === "MANUAL_REVIEW") review++;
  }
  return { precision: auto ? autoCorrect / auto : 1, recall: matchable ? found / matchable : 1, wrongAuto, falseOnUnpaid, unpaid, review, auto };
}

const SCENARIOS: Scenario[] = [
  { name: "clean names, same-day pay", n: 200, payDelay: [0, 0], noise: "clean", tdsShare: 0, unpaidShare: 0.1, sameAmount: false, wrongAmountDecoys: false },
  { name: "noisy bank narrations + invoice no.", n: 200, payDelay: [0, 10], noise: "bank", tdsShare: 0, unpaidShare: 0.1, sameAmount: false, wrongAmountDecoys: false },
  { name: "abbreviated vendor names", n: 200, payDelay: [0, 10], noise: "abbrev", tdsShare: 0, unpaidShare: 0.1, sameAmount: false, wrongAmountDecoys: false },
  { name: "late payments (up to 40d)", n: 200, payDelay: [10, 40], noise: "bank", tdsShare: 0, unpaidShare: 0.1, sameAmount: false, wrongAmountDecoys: false },
  { name: "net-of-TDS payments (30%)", n: 200, payDelay: [0, 15], noise: "bank", tdsShare: 0.3, unpaidShare: 0.1, sameAmount: false, wrongAmountDecoys: false },
  { name: "repeated round amounts (collisions)", n: 150, payDelay: [0, 12], noise: "bank", tdsShare: 0, unpaidShare: 0.1, sameAmount: true, wrongAmountDecoys: false },
  { name: "unpaid invoices + wrong-amount decoys", n: 200, payDelay: [0, 10], noise: "bank", tdsShare: 0, unpaidShare: 0.4, sameAmount: false, wrongAmountDecoys: true },
];

test("v2 engine accuracy vs legacy across dataset types", () => {
  const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
  const lines = ["scenario".padEnd(40) + "| legacy prec/recall/wrongAuto | v2 prec/recall/wrongAuto/review"];
  for (const sc of SCENARIOS) {
    const { invoices, bank, truth } = build(sc, 42);
    const L = score(reconcileBatchLegacy(invoices, bank), truth);
    const N = score(reconcileBatch(invoices, bank), truth);
    lines.push(`${sc.name.padEnd(40)}| ${pct(L.precision)} ${pct(L.recall)} ${String(L.wrongAuto).padStart(3)}        | ${pct(N.precision)} ${pct(N.recall)} ${String(N.wrongAuto).padStart(3)} ${String(N.review).padStart(3)}`);
    assert.ok(N.precision >= 0.97, `${sc.name}: v2 auto-match precision ${N.precision}`);
    assert.ok(N.wrongAuto <= L.wrongAuto, `${sc.name}: v2 must not auto-approve more wrong matches than legacy`);
    assert.equal(N.falseOnUnpaid, 0, `${sc.name}: unpaid invoice auto-matched`);
  }
  console.log("\n" + lines.join("\n") + "\n");
});
