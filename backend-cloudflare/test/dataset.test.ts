import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseDataset, parseDate, parseAmount } from "../src/pipelines/dataset.ts";

test("dates: many formats incl. Excel serial", () => {
  assert.equal(parseDate("05/03/2026"), "2026-03-05");
  assert.equal(parseDate("5-3-2026"), "2026-03-05");
  assert.equal(parseDate("2026-03-05T10:20:00Z"), "2026-03-05");
  assert.equal(parseDate("05-Mar-2026"), "2026-03-05");
  assert.equal(parseDate("5 Sept 26"), "2026-09-05");
  assert.equal(parseDate(46086), "2026-03-05"); // Excel serial
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseDate("Total"), null);
});

test("amounts: Indian formats, parentheses, Dr/Cr", () => {
  assert.equal(parseAmount("₹1,23,456.50"), 123456.5);
  assert.equal(parseAmount("(2,500.00)"), -2500);
  assert.equal(parseAmount("4,000.00 Dr"), -4000);
  assert.equal(parseAmount("4,000.00 Cr"), 4000);
  assert.equal(parseAmount("Rs. 99"), 99);
  assert.equal(parseAmount("-"), 0);
});

test("bank statement with preamble rows and separate debit/credit (CSV or XLSX grid)", () => {
  const rows = [
    ["HDFC BANK LTD", "", "", ""], ["Statement of account", "", "", ""],
    ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt."],
    ["05/03/26", "NEFT-ACME TRADERS-REF1", "11,800.00", ""],
    [46090, "UPI-Customer", "", 5000],
    ["", "Closing balance", "", ""],
  ];
  const d = normaliseDataset(rows)!;
  assert.equal(d.datasetType, "BANK_STATEMENT");
  assert.equal(d.bank.length, 2);
  assert.deepEqual([d.bank[0]!.debit, d.bank[1]!.credit], [11800, 5000]);
});

test("bank statement with single signed amount + Dr/Cr column", () => {
  const rows = [["Txn Date", "Description", "Amount", "Dr/Cr"], ["01-04-2026", "Rent", "25,000", "DR"], ["02-04-2026", "Sale", "9,000", "CR"]];
  const d = normaliseDataset(rows)!;
  assert.equal(d.datasetType, "BANK_STATEMENT");
  assert.deepEqual([d.bank[0]!.debit, d.bank[1]!.credit], [25000, 9000]);
});

test("purchase register / invoice list classified and total derived from taxable+tax", () => {
  const rows = [["Invoice No", "Invoice Date", "Supplier Name", "GSTIN", "Taxable Value", "IGST"], ["INV-1", "2026-03-01", "Acme Traders", "27ABCDE1234F1Z5", 10000, 1800]];
  const d = normaliseDataset(rows)!;
  assert.equal(d.datasetType, "GST_RETURN");
  assert.equal(d.invoices[0]!.total, 11800);
  assert.equal(d.invoices[0]!.gstin, "27ABCDE1234F1Z5");
});

test("unrecognised sheet returns null instead of garbage", () => {
  assert.equal(normaliseDataset([["foo", "bar"], [1, 2]]), null);
});

import { reconcileBatch } from "../src/pipelines/reconciliation.ts";
test("end to end: invoice register + bank statement grids reconcile", () => {
  const inv = normaliseDataset([["Invoice No", "Invoice Date", "Supplier Name", "GSTIN", "Taxable Value", "IGST"], ["INV-1001", "2026-05-01", "Acme Traders Pvt Ltd", "27ABCDE1234F1Z5", 10000, 1800], ["INV-1002", "2026-05-02", "Sharma Steel", "", 5000, 900]])!;
  const bank = normaliseDataset([["Txn Date", "Description", "Withdrawal Amt.", "Deposit Amt."], ["2026-05-06", "NEFT-ACME TRADERS PVT LTD-REF1 INV-1001", 11800, ""], ["2026-05-07", "UPI-SOMEONE ELSE", 5900, ""]])!;
  const res = reconcileBatch(
    inv.invoices.map((i, k) => ({ documentId: `d${k}`, vendorName: i.vendor, rawTotalAmount: i.total, documentDate: i.date, invoiceNumber: i.invoiceNo })),
    bank.bank.map((b, k) => ({ transactionId: `b${k}`, narration: b.narration, debitAmount: b.debit, transactionDate: b.date })),
  );
  assert.equal(res[0]!.status, "RECONCILED");
  assert.equal(res[0]!.matchedBankTransactionId, "b0");
  assert.notEqual(res[1]!.status, "RECONCILED"); // same amount, different payee → never auto-approved
});
