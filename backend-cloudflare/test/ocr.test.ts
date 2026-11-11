// Field extraction from OCR'd invoice text (PDF / photo uploads). Each case is a realistic invoice layout with the
// values a human reads off it; a wrong total or invoice number here silently breaks reconciliation downstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { processDocument } from "../src/pipelines/ocr.ts";

const lines = (t: string) => t.trim().split("\n").map((text) => ({ text, confidence: 0.93 }));
interface Case { name: string; text: string; want: { vendorName: string; documentDate: string; rawTotalAmount: number; taxAmount?: number; taxIdentifier?: string; invoiceNumber?: string } }

const CASES: Case[] = [
  { name: "GST tax invoice: sub total, CGST+SGST, grand total, GSTIN line, 'TAX INVOICE' above the invoice number", want: { vendorName: "ACME TRADERS PVT LTD", documentDate: "2026-03-05", rawTotalAmount: 11446, taxAmount: 1746, taxIdentifier: "27AAACA1234F1Z5", invoiceNumber: "INV-2026-0042" }, text: `
ACME TRADERS PVT LTD
123, MG Road, Andheri East, Mumbai 400069
GSTIN: 27AAACA1234F1Z5
TAX INVOICE
Invoice No: INV-2026-0042
Invoice Date: 05/03/2026
Bill To: Example Traders
GSTIN: 29BBBBB5678C1Z9
1  Steel Rods 10mm   100 kg   85.00   8,500.00
2  Binding Wire      20 kg    60.00   1,200.00
Sub Total            9,700.00
CGST @9%               873.00
SGST @9%               873.00
Total Tax            1,746.00
Grand Total         11,446.00
Amount in words: Rupees Eleven Thousand Four Hundred Forty Six Only` },
  { name: "IGST invoice with 'Inv No.', textual month, ₹ amounts", want: { vendorName: "Sharma Steel Works", documentDate: "2026-03-05", rawTotalAmount: 59000, taxAmount: 9000, invoiceNumber: "1023" }, text: `
Sharma Steel Works
Plot 44, MIDC, Jaipur
Inv No. 1023
Date: 5-Mar-2026
Taxable Value ₹ 50,000.00
IGST 18% ₹ 9,000.00
Total Amount ₹ 59,000.00` },
  { name: "retail receipt: TOTAL, cash tendered and change are larger/smaller numbers", want: { vendorName: "RELIANCE FRESH", documentDate: "2026-03-05", rawTotalAmount: 1234.5 }, text: `
RELIANCE FRESH
Store 4412, Pune
Date 05/03/2026 18:42
Milk 2L        120.00
Rice 5kg       640.50
Oil 1L         474.00
TOTAL         1,234.50
CASH          2,000.00
CHANGE          765.50` },
  { name: "utility bill: bill date vs DUE date, amount payable", want: { vendorName: "BESCOM Electricity Supply", documentDate: "2026-03-12", rawTotalAmount: 2345 }, text: `
BESCOM Electricity Supply
Bill Date: 12-03-2026
Due Date: 28-03-2026
Previous Reading 10234  Current Reading 10456
Energy Charges 2,100.00
Amount Payable: ₹ 2,345.00` },
  { name: "ISO date, GST 5%, total", want: { vendorName: "Hotel Sunrise Residency", documentDate: "2026-03-05", rawTotalAmount: 1050, taxAmount: 50 }, text: `
Hotel Sunrise Residency
Date: 2026-03-05
Net Amount 1,000.00
GST 5% 50.00
Total 1,050.00` },
  { name: "'March 12, 2026' dates and 'Invoice #' label", want: { vendorName: "Nova Print Solutions", documentDate: "2026-03-12", rawTotalAmount: 7080, invoiceNumber: "BL-778" }, text: `
Nova Print Solutions
INVOICE
Invoice #: BL-778
Invoice Date: March 12, 2026
Due Date: April 11, 2026
Total: 7,080.00` },
  { name: "'Total Qty' appears before the real total", want: { vendorName: "Om Sai Enterprises", documentDate: "2026-04-01", rawTotalAmount: 11800 }, text: `
Om Sai Enterprises
Invoice Date: 01/04/2026
Item A  5  1000.00
Item B  5  1000.00
Total Qty: 10
Total: 11,800.00` },
  { name: "e-Invoice: IRN + Ack date must not beat the invoice date", want: { vendorName: "Kiran Logistics LLP", documentDate: "2026-03-05", rawTotalAmount: 23600, invoiceNumber: "KL/26-27/0099" }, text: `
Kiran Logistics LLP
e-Invoice
IRN: 8f3d9a1c2b7e4d5f6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f
Ack No: 112610012345678
Ack Date: 06/03/2026 12:00:00
Invoice No: KL/26-27/0099
Invoice Date: 05/03/2026
Total Invoice Value 23,600.00` },
  { name: "partly paid: Balance Due is smaller than the invoice total", want: { vendorName: "Delta Office Supplies", documentDate: "2026-03-05", rawTotalAmount: 11800 }, text: `
Delta Office Supplies
Invoice Date: 05/03/2026
Total: 11,800.00
Paid: 6,800.00
Balance Due: 5,000.00` },
  { name: "Rs. and /- amount styles", want: { vendorName: "Patel Chemicals Ltd", documentDate: "2026-02-27", rawTotalAmount: 11800 }, text: `
Patel Chemicals Ltd
Date: 27.02.2026
Net Payable: Rs. 11,800/-` },
  { name: "vendor name containing 'Bill' / 'Invoice' words is not mistaken for a header", want: { vendorName: "Billion Traders", documentDate: "2026-03-05", rawTotalAmount: 500 }, text: `
Billion Traders
Date: 05/03/2026
Total 500.00` },
  { name: "header lines above the vendor are skipped", want: { vendorName: "Greenfield Agro Pvt Ltd", documentDate: "2026-03-05", rawTotalAmount: 5900 }, text: `
ORIGINAL FOR RECIPIENT
TAX INVOICE
Greenfield Agro Pvt Ltd
Phone: 9876543210  Email: accounts@greenfield.in
Invoice Date: 05/03/2026
Grand Total ₹ 5,900.00` },
];

for (const c of CASES) {
  test(`ocr extraction — ${c.name}`, () => {
    const r = processDocument(lines(c.text));
    const got = { vendorName: r.vendorName, documentDate: r.documentDate, rawTotalAmount: r.rawTotalAmount, ...(c.want.taxAmount !== undefined ? { taxAmount: r.taxAmount } : {}), ...(c.want.taxIdentifier !== undefined ? { taxIdentifier: r.taxIdentifier } : {}), ...(c.want.invoiceNumber !== undefined ? { invoiceNumber: r.invoiceNumber } : {}) };
    assert.deepEqual(got, c.want);
  });
}
test("ocr: empty input is an explicit 'OCR did not run', not an error", () => assert.equal(processDocument([]).ocrAvailable, false));
