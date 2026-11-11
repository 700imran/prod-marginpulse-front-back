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

// ── Books ledgers and sales registers must not be mistaken for bank movements / payables ─────────────────────
test("Tally day-book: only bank-type vouchers become bank rows; Sales / Purchase / Journal are ignored", () => {
  const grid = [
    ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
    ["01-04-2026", "Customer One", "Sales", "S-1", 11800, ""],
    ["02-04-2026", "Customer One", "Receipt", "R-1", 11800, ""],     // books view: Debit = money in
    ["03-04-2026", "Acme Traders", "Purchase", "P-1", "", 5900],
    ["04-04-2026", "Acme Traders", "Payment", "PM-1", "", 5900],     // books view: Credit = money out
    ["05-04-2026", "Adjustment", "Journal", "J-1", 100, ""],
  ];
  const d = normaliseDataset(grid)!;
  assert.equal(d.datasetType, "BANK_STATEMENT");
  assert.deepEqual(d.bank.map((b) => [b.date, b.debit, b.credit]), [["2026-04-02", 0, 11800], ["2026-04-04", 5900, 0]]);
  assert.match(d.warnings.join(" "), /3 non-bank voucher/);
});

test("a bank ledger whose voucher types are all Payment / Receipt / Contra keeps every row", () => {
  const grid = [["Date", "Particulars", "Vch Type", "Debit", "Credit"], ["01-04-2026", "X", "Receipt", 10, ""], ["02-04-2026", "Y", "Payment", "", 20], ["03-04-2026", "Cash", "Contra", "", 30]];
  const d = normaliseDataset(grid)!;
  assert.equal(d.bank.length, 3);
  assert.doesNotMatch(d.warnings.join(" "), /non-bank/);
});

test("sales registers are flagged (so the API can refuse them instead of importing customers as payables)", () => {
  const gstr1 = [["GSTIN of recipient", "Customer name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"],
    ["27AAACA1234F1Z5", "ACME CUSTOMER", "S-1", "Regular", "03-04-2026", 11800, 10000, 0, 900, 900, 0]];
  assert.equal(normaliseDataset(gstr1)!.salesRegister, true);
  assert.equal(normaliseDataset([["Invoice No", "Customer", "Invoice Date", "Amount"], ["S-1", "C1", "01-04-2026", 100]])!.salesRegister, true);
  assert.equal(normaliseDataset([["Invoice No", "Supplier", "Invoice Date", "Amount"], ["P-1", "V1", "01-04-2026", 100]])!.salesRegister ?? false, false);
  assert.equal(normaliseDataset([["GSTIN of supplier", "Trade name", "Invoice number", "Invoice Date", "Invoice Value(₹)"], ["27AAACA1234F1Z5", "ACME", "P-1", "03-04-2026", 100]])!.salesRegister ?? false, false);
});

test("GSTR-2B (supplier-side) is never mistaken for a sales register just because a column says GSTR-1 Period", () => {
  const grid = [
    ["GSTIN of supplier", "Trade/Legal name", "Invoice details", "", "", "", "Taxable Value (₹)", "Tax Amount", "", "", "", "GSTR-1/1A/IFF/GSTR-5 Period"],
    ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", ""],
    ["24AAACP6789C1Z8", "Patel Chemicals Ltd", "INV1", "Regular", "03-06-2026", 59176.4, 50149.49, 0, 4513.46, 4513.46, 0, "Apr-26"],
  ];
  const d = normaliseDataset(grid)!;
  assert.equal(d.datasetType, "GST_RETURN");
  assert.ok(!d.salesRegister);
  assert.equal(d.invoices.length, 1);
});
