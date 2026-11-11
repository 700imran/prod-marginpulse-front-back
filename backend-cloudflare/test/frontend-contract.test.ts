// Cross-stack contract: the EXACT payloads the browser's file parser produces (committed under
// test/fixtures/frontend-parsed, regenerated and verified from the frontend suite) are fed to the server's
// normaliser. Asserts the values, not just the shape — and then reconciles bank files against GST / books files
// that came from DIFFERENT formats (xlsx × xlsx, html-xls × json, fixed-width × tally xml …).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseWorkbook, type NormalisedDataset } from "../src/pipelines/dataset.ts";
import { reconcileBatch } from "../src/pipelines/reconciliation.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "frontend-parsed");
const load = (name: string): NormalisedDataset => {
  const { sheets } = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
  const d = normaliseWorkbook(sheets);
  assert.ok(d, `${name}: not recognised`);
  return d;
};
const bankOf = (d: NormalisedDataset) => d.bank.map((b) => [b.date, b.debit, b.credit, b.narration]);
const invOf = (d: NormalisedDataset) => d.invoices.map((i) => ({ no: i.invoiceNo, date: i.date, total: i.total, tax: i.tax, type: i.docType }));

test("bank — multi-sheet xlsx: monthly sheets merged, cover sheet skipped, real Date cells right", () => {
  const d = load("bank-monthly.xlsx");
  assert.equal(d.datasetType, "BANK_STATEMENT");
  assert.deepEqual(bankOf(d), [
    ["2026-04-03", 11800, 0, "NEFT-ACME TRADERS-REF1"], ["2026-04-09", 0, 5000, "UPI-CUSTOMER RECEIPT"],
    ["2026-05-02", 59000, 0, "RTGS-SHARMA STEEL WORKS"], ["2026-05-20", 0, 800, "INTEREST CREDIT"],
  ]);
  assert.match(d.warnings.join(" "), /Skipped sheet\(s\).*Summary/);
});

test("bank — HTML masquerading as .xls (Withdrawals / Deposits / Balance columns)", () => {
  assert.deepEqual(bankOf(load("bank-html.xls")), [
    ["2026-03-05", 11800, 0, "NEFT-ACME TRADERS"], ["2026-03-06", 0, 5000, "UPI-CUSTOMER ONE"], ["2026-03-07", 2500, 0, "NEFT-BETA LLP"],
  ]);
});

test("bank — fixed-width report: Credit-only rows stay credits, banner / footer ignored", () => {
  const d = load("bank-fixed-width.prn");
  assert.equal(d.datasetType, "BANK_STATEMENT");
  assert.deepEqual(bankOf(d), [
    ["2026-03-05", 11800, 0, "NEFT-ACME TRADERS"], ["2026-03-06", 0, 5000, "UPI-CUSTOMER ONE"],
    ["2026-03-07", 2500, 0, "NEFT-BETA LLP"], ["2026-03-08", 0, 12, "INT CREDIT"],
  ]);
});

test("invoices — GSTR-2B portal xlsx: cover sheet skipped, two-row header, CDNR → credit note", () => {
  const d = load("gstr2b-portal.xlsx");
  assert.equal(d.datasetType, "GST_RETURN");
  assert.deepEqual(invOf(d), [
    { no: "INV-1001", date: "2026-04-03", total: 11800, tax: 1800, type: "INVOICE" },
    { no: "SS/26/77", date: "2026-04-28", total: 59000, tax: 9000, type: "INVOICE" },
    { no: "CN-9", date: "2026-05-15", total: 2360, tax: 360, type: "CREDIT_NOTE" },
  ]);
  assert.equal(d.invoices[1]!.gstin, "08AABCS5678K1Z2");
});

test("invoices — GSTR-2B API JSON: item taxes summed across items, note typed as credit note", () => {
  const d = load("gstr2b-api.json");
  assert.equal(d.datasetType, "GST_RETURN");
  assert.deepEqual(invOf(d), [
    { no: "INV-1001", date: "2026-04-03", total: 11800, tax: 1800, type: "INVOICE" },
    { no: "INV-1002", date: "2026-04-09", total: 5900, tax: 900, type: "INVOICE" },   // 500 + 400 across two items
    { no: "CN-9", date: "2026-05-15", total: 2360, tax: 360, type: "CREDIT_NOTE" },
  ]);
});

test("invoices — typed-date purchase register xlsx (Date cells, paise)", () => {
  const d = load("bills-typed.xlsx");
  assert.equal(d.datasetType, "INVOICE_REGISTER");
  assert.deepEqual(invOf(d), [
    { no: "B-1", date: "2026-04-01", total: 1180, tax: 180, type: "INVOICE" },
    { no: "B-2", date: "2026-04-02", total: 2360.59, tax: 360.09, type: "INVOICE" },
  ]);
});

test("invoices — Tally day-book XML: purchase kept, receipt dropped, debit note flagged", () => {
  const d = load("tally-daybook.xml");
  assert.deepEqual(invOf(d), [
    { no: "P-1", date: "2026-04-05", total: 11800, tax: 0, type: "INVOICE" },
    { no: "DN-1", date: "2026-04-07", total: 500, tax: 0, type: "CREDIT_NOTE" },
  ]);
});

const engine = (inv: NormalisedDataset, bank: NormalisedDataset) => ({
  invoices: inv.invoices.filter((i) => i.docType !== "CREDIT_NOTE").map((i) => ({ documentId: i.invoiceNo, vendorName: i.vendor, rawTotalAmount: i.total, documentDate: i.date, invoiceNumber: i.invoiceNo })),
  rows: bank.bank.map((b, k) => ({ transactionId: `row${k}`, narration: b.narration, debitAmount: b.debit, transactionDate: b.date })),
});

test("cross-format reconcile: monthly-xlsx bank × GSTR-2B portal xlsx", () => {
  const { invoices, rows } = engine(load("gstr2b-portal.xlsx"), load("bank-monthly.xlsx"));
  const res = Object.fromEntries(reconcileBatch(invoices, rows).map((m) => [m.documentId, m]));
  assert.equal(res["INV-1001"]!.status, "RECONCILED"); assert.equal(res["INV-1001"]!.matchedBankTransactionId, "row0");
  assert.equal(res["SS/26/77"]!.status, "RECONCILED"); assert.equal(res["SS/26/77"]!.matchedBankTransactionId, "row2");
});

test("cross-format reconcile: HTML-xls bank × GSTR-2B API json (paid + unpaid invoice)", () => {
  const { invoices, rows } = engine(load("gstr2b-api.json"), load("bank-html.xls"));
  const res = Object.fromEntries(reconcileBatch(invoices, rows).map((m) => [m.documentId, m]));
  // The bank pays ACME ₹11,800 on 05-Mar, but INV-1001 is dated 03-Apr — payment BEFORE the invoice is outside the window → not auto-approved.
  assert.notEqual(res["INV-1001"]!.status, "RECONCILED");
  assert.notEqual(res["INV-1002"]!.status, "RECONCILED"); // ₹5,900 never left the account
});

test("cross-format reconcile: fixed-width bank × Tally XML — same party, amounts line up", () => {
  const { invoices, rows } = engine(load("tally-daybook.xml"), load("bank-fixed-width.prn"));
  // P-1 (₹11,800, 5 Apr) is after every payment in this file → must NOT be force-matched to the 5 Mar ₹11,800 debit.
  const res = reconcileBatch(invoices, rows);
  assert.equal(res.filter((m) => m.status === "RECONCILED").length, 0);
});
