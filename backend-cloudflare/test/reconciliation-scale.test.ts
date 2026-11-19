// Scale guard for the reconciliation engine (src/pipelines/reconciliation.ts: countCandidatePairs / reconcileBatchBudgeted).
// The engine's memory grows with the SQUARE of how many invoices share an amount; the budgeted wrapper must (a) change nothing for
// ordinary data, and (b) keep one-to-one, ordering and match quality when it has to split the work into date slices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileBatch, reconcileBatchBudgeted, countCandidatePairs, type Invoice, type BankRow } from "../src/pipelines/reconciliation.ts";

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const VENDORS = ["Acme Traders Pvt Ltd", "Sharma Steel Works", "Bharat Packaging Co", "Kiran Logistics LLP", "Om Sai Enterprises", "Delta Office Supplies"];

/** Distinct amounts: invoices never compete for the same bank row, so slicing must not change a single result. */
function distinct(n: number, seed = 1) {
  const r = rng(seed); const invoices: Invoice[] = []; const bank: BankRow[] = [];
  for (let i = 0; i < n; i++) {
    const vendor = VENDORS[Math.floor(r() * VENDORS.length)]!;
    const amount = 1000 + i * 37 + Math.round(r() * 100) / 100; // unique, spread out
    const date = addDays("2026-01-01", Math.floor(r() * 120));
    invoices.push({ documentId: `inv${i}`, vendorName: vendor, rawTotalAmount: amount, documentDate: date, invoiceNumber: `INV-${1000 + i}` });
    if (r() < 0.8) bank.push({ transactionId: `tx${i}`, narration: `NEFT-${vendor.toUpperCase()}`, debitAmount: amount, transactionDate: addDays(date, 2 + Math.floor(r() * 20)) });
  }
  return { invoices, bank };
}

/** Every invoice the same amount (rent / retainers): the quadratic worst case. Each one is paid, with its own invoice number in the narration. */
function sameAmount(n: number, withRefs: boolean, spread = 150) {
  const invoices: Invoice[] = []; const bank: BankRow[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays("2026-01-01", i % spread);
    invoices.push({ documentId: `inv${i}`, vendorName: "ACME TRADERS PVT LTD", rawTotalAmount: 50_000, documentDate: date, invoiceNumber: `INV-${1000 + i}` });
    bank.push({ transactionId: `tx${i}`, narration: withRefs ? `NEFT-ACME TRADERS PVT LTD-INV-${1000 + i}` : "NEFT-ACME TRADERS PVT LTD", debitAmount: 50_000, transactionDate: addDays(date, 5) });
  }
  return { invoices, bank };
}

test("countCandidatePairs equals the number of candidates reconcileBatch actually builds (ordinary, same-amount and junk rows)", () => {
  const junkInv: Invoice[] = [
    { documentId: "j1", vendorName: "X", rawTotalAmount: 0, documentDate: "2026-02-01" },
    { documentId: "j2", vendorName: "X", rawTotalAmount: -5, documentDate: "2026-02-01" },
    { documentId: "j3", vendorName: "X", rawTotalAmount: 100, documentDate: "" },
    { documentId: "j4", vendorName: "X", rawTotalAmount: 100, documentDate: "not-a-date" },
  ];
  const junkBank: BankRow[] = [
    { transactionId: "b1", narration: "x", debitAmount: 0, transactionDate: "2026-02-02" },
    { transactionId: "b2", narration: "x", debitAmount: 100, transactionDate: "" },
    { transactionId: "b3", narration: "x", debitAmount: 100, transactionDate: "garbage" },
    { transactionId: "b4", narration: "x", debitAmount: 100, transactionDate: "2026-02-03" },
  ];
  for (const { invoices, bank } of [distinct(300, 7), sameAmount(120, true), { invoices: junkInv, bank: junkBank }, { invoices: [...junkInv, ...distinct(50, 3).invoices], bank: [...junkBank, ...distinct(50, 3).bank] }]) {
    const stats = { candidates: -1 };
    reconcileBatch(invoices, bank, undefined, undefined, stats);
    assert.equal(countCandidatePairs(invoices, bank), stats.candidates);
  }
});

test("countCandidatePairs stops counting once past the limit (it must never allocate the pairs it is guarding against)", () => {
  const { invoices, bank } = sameAmount(2000, false); // ~ millions of pairs if fully counted
  const n = countCandidatePairs(invoices, bank, 1000);
  assert.ok(n > 1000 && n < 1000 + 5000, `stopped early at ${n}`);
});

test("under the budget, reconcileBatchBudgeted IS reconcileBatch — identical output, no slicing", () => {
  for (const { invoices, bank } of [distinct(400, 11), sameAmount(60, true), sameAmount(60, false)]) {
    let sliced = 0;
    const a = reconcileBatchBudgeted(invoices, bank, { maxPairs: 1_500_000, onSliced: () => sliced++ });
    assert.deepEqual(a, reconcileBatch(invoices, bank));
    assert.equal(sliced, 0);
  }
});

const reconciledMap = (res: ReturnType<typeof reconcileBatch>) => new Map(res.filter((r) => r.status === "RECONCILED").map((r) => [r.documentId, r.matchedBankTransactionId]));
/** Nobody suggests (or claims) a bank row that another invoice has auto-matched, and no bank row is auto-matched twice. */
function assertConsistent(res: ReturnType<typeof reconcileBatch>) {
  const owner = new Map<string, string>();
  for (const r of res) if (r.status === "RECONCILED") { assert.ok(r.matchedBankTransactionId); assert.ok(!owner.has(r.matchedBankTransactionId!), `bank row ${r.matchedBankTransactionId} auto-matched twice`); owner.set(r.matchedBankTransactionId!, r.documentId); }
  for (const r of res) if (r.status === "MANUAL_REVIEW" && r.candidateBankTransactionId) { const o = owner.get(r.candidateBankTransactionId); assert.ok(!o || o === r.documentId, `${r.documentId} suggests ${r.candidateBankTransactionId}, which ${o} owns`); }
}

test("over the budget with no real competition, slicing auto-matches exactly what the single global pass does", () => {
  const { invoices, bank } = distinct(500, 5);
  const whole = reconcileBatch(invoices, bank);
  let slices = 0;
  const sliced = reconcileBatchBudgeted(invoices, bank, { maxPairs: 40, onSliced: (n) => { slices = n; } });
  assert.ok(slices > 1, `expected several slices, got ${slices}`);
  assert.equal(sliced.length, whole.length);
  assert.deepEqual(reconciledMap(sliced), reconciledMap(whole));
  assertConsistent(sliced);
});

test("sliced results stay aligned to the input order and stay consistent (no bank row auto-matched twice, no suggestion on a row someone owns)", () => {
  const { invoices, bank } = sameAmount(400, false); // ambiguous on purpose: lots of MANUAL_REVIEW proposals
  let slices = 0;
  const res = reconcileBatchBudgeted(invoices, bank, { maxPairs: 5_000, onSliced: (n) => { slices = n; } });
  assert.ok(slices > 1);
  assert.equal(res.length, invoices.length);
  res.forEach((r, i) => assert.equal(r.documentId, invoices[i]!.documentId, "result i belongs to invoice i"));
  assertConsistent(res);
});

test("sliced: a decisive invoice number in the narration still reconciles to the right payment, across slice boundaries", () => {
  const { invoices, bank } = sameAmount(300, true);
  let slices = 0;
  const res = reconcileBatchBudgeted(invoices, bank, { maxPairs: 3_000, onSliced: (n) => { slices = n; } });
  assert.ok(slices > 1, `expected slicing, got ${slices}`);
  res.forEach((r, i) => { assert.equal(r.status, "RECONCILED", `inv${i}: ${r.status} ${r.reason}`); assert.equal(r.matchedBankTransactionId, `tx${i}`); });
});

test("safety: sliced mode is never MORE eager than the single pass — everything it auto-matches, the global pass auto-matches to the same payment", () => {
  // Same amounts across several vendors and no invoice numbers: the global pass auto-matches by vendor evidence where it is unambiguous.
  const r = rng(21); const invoices: Invoice[] = []; const bank: BankRow[] = [];
  for (let i = 0; i < 360; i++) {
    const vendor = VENDORS[i % VENDORS.length]!; const date = addDays("2026-02-01", Math.floor(r() * 30));
    const amount = [10_000, 25_000, 50_000][Math.floor(r() * 3)]!;
    invoices.push({ documentId: `inv${i}`, vendorName: vendor, rawTotalAmount: amount, documentDate: date });
    if (r() < 0.9) bank.push({ transactionId: `tx${i}`, narration: `NEFT-${vendor.toUpperCase()}`, debitAmount: amount, transactionDate: addDays(date, 3 + Math.floor(r() * 10)) });
  }
  const whole = reconciledMap(reconcileBatch(invoices, bank));
  for (const maxPairs of [200, 2_000, 20_000]) {
    const sliced = reconcileBatchBudgeted(invoices, bank, { maxPairs });
    for (const [doc, tx] of reconciledMap(sliced)) assert.equal(whole.get(doc), tx, `maxPairs=${maxPairs}: ${doc} auto-matched to ${tx} but the global pass did not`);
    assertConsistent(sliced);
  }
});

test("a wrong amount can never match, sliced or not (the hard amount gate survives slicing)", () => {
  const { invoices, bank } = distinct(200, 9);
  const wrong = bank.map((b, k) => ({ ...b, debitAmount: 5_000_000 + k * 1_000 })); // far outside every invoice amount and its TDS / tolerance bands
  for (const maxPairs of [1_500_000, 10]) {
    const res = reconcileBatchBudgeted(invoices, wrong, { maxPairs });
    assert.ok(res.every((r) => r.status !== "RECONCILED"), `maxPairs=${maxPairs}`);
  }
});

test("worst case at the default budget: 2,500 identical-amount invoices (5.8 M pairs) finish in slices, every one reconciled to its own payment", () => {
  const { invoices, bank } = sameAmount(2_500, true, 20); // all inside one payment window
  let slices = 0;
  const t0 = Date.now();
  const res = reconcileBatchBudgeted(invoices, bank, { onSliced: (n) => { slices = n; } });
  const ms = Date.now() - t0;
  assert.ok(slices >= 10, `expected many slices at the default 400 k budget, got ${slices}`);
  assert.equal(res.length, 2_500);
  assert.equal(res.filter((r, i) => r.status === "RECONCILED" && r.matchedBankTransactionId === `tx${i}`).length, 2_500);
  assertConsistent(res);
  console.log(`worst case, 2,500 identical invoices: ${slices} slices, ${ms} ms`);
  assert.ok(ms < 30_000, `took ${ms} ms`);
});

test("CPU cap: past maxTotalPairs the remaining invoices are reported FAILED with a reason (not attempted, not silently dropped); the rest are still matched", () => {
  const { invoices, bank } = sameAmount(400, true, 20); // 160 k pairs
  let skipped = -1;
  const res = reconcileBatchBudgeted(invoices, bank, { maxPairs: 20_000, maxTotalPairs: 60_000, onCapped: (n) => { skipped = n; } });
  assert.equal(res.length, 400);
  res.forEach((r, i) => assert.equal(r.documentId, `inv${i}`));
  const failed = res.filter((r) => r.status === "FAILED");
  assert.ok(failed.length > 0 && failed.length < 400, `failed=${failed.length}`);
  assert.equal(skipped, failed.length);
  assert.ok(failed.every((r) => /look-alike invoices/.test(r.reason) && r.matchedBankTransactionId === null));
  const ok = res.filter((r) => r.status === "RECONCILED");
  assert.equal(ok.length, 400 - failed.length, "everything that was attempted (invoice numbers present) reconciled");
  assertConsistent(res);
});

test("the cap never triggers for ordinary data, and the engine's own FAILED (missing date/amount) is untouched", () => {
  const { invoices, bank } = distinct(300, 4);
  invoices.push({ documentId: "bad", vendorName: "X", rawTotalAmount: 0, documentDate: "2026-01-01" });
  let capped = 0;
  const res = reconcileBatchBudgeted(invoices, bank, { maxPairs: 30, onCapped: () => capped++ });
  assert.equal(capped, 0);
  assert.equal(res.at(-1)!.status, "FAILED");
  assert.equal(res.at(-1)!.reason, "Missing amount or date for matching");
});
