// Port of internal/pipelines/ocr/ocr.go's field-extraction half.
//
// The Lambda-calling half (invokeOCRLambda, arrayBufferToBase64) has
// been REMOVED — this used to call an AWS Lambda Function URL to turn
// a file into raw OCR text, but that requires an AWS account, which
// this deployment deliberately doesn't have. OCR now runs entirely in
// the browser instead (Shape Detection API / Tesseract.js — see
// frontend/src/ocr/), and the browser sends already-extracted lines
// here instead of raw file bytes. There is no server-side OCR fallback
// of any kind: if the browser couldn't produce lines (unsupported
// browser, or WhatsApp/email ingestion where there's no browser in the
// loop at all), the document lands with ocrAvailable: false and empty
// fields for manual correction via the existing correction workflow.
//
// Everything below — all the regex-based field extraction — is still
// an exact, unchanged port: same patterns, same order, same fallbacks.
// It now runs against whatever lines it's given instead of lines
// fetched from a Lambda.

export interface OCRResult {
  ocrAvailable: boolean;
  vendorName: string;
  documentDate: string; // ISO YYYY-MM-DD or ""
  rawTotalAmount: number;
  taxAmount: number;
  taxIdentifier: string;
  invoiceNumber: string;
  rawText: string;
  confidence: number;
}

export interface OcrLine {
  text: string;
  confidence: number; // 0-1 scale — matches ocr_confidence_threshold in settings (db/schema.sql)
}

// ── field extraction ─────────────────────────────────────────────────────
// Works line by line with LABEL PRIORITY (a grand total beats a total, a total beats a balance due, an invoice date
// beats a due date), instead of the first regex hit anywhere in the text — which read "Sub Total" as the total,
// "GSTIN: 27AAA…" as the tax amount and the word "Invoice" as the invoice number.
import { parseDate } from "./dataset";

const GSTIN_PATTERN = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b/;
const MONEY_RE = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s*%)?/gi;

// All money-looking numbers on a line, minus percentages ("@9%", "18 %") and the digits inside long ids.
function amountsIn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY_RE)) {
    if (m[2]) continue;
    const start = m.index! + m[0].indexOf(m[1]!); // where the DIGITS begin (the match may start with spaces / a ₹ prefix)
    const before = line.slice(Math.max(0, start - 1), start);
    if (before === "@" || (/[A-Za-z]/.test(before) && !/[₹]/.test(m[0]))) continue; // "@9%", or digits glued to letters like INV2026
    const v = parseFloat(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}
const lastAmount = (line: string) => { const a = amountsIn(line); return a.length ? a[a.length - 1]! : null; };

const NOT_A_TOTAL = /sub\s*-?\s*total|total\s*(tax|gst|cgst|sgst|igst|discount|qty|quantity|items?|weight|units|pcs|taxable|cess)|in\s*words|amount\s*chargeable|\bdue\s*date\b/i;
const TOTAL_TIERS: RegExp[] = [
  /grand\s*total/i,
  /(invoice|bill)\s*(total|value|amount)|total\s*(invoice\s*)?(amount|value)|net\s*(amount\s*)?payable|amount\s*payable|total\s*payable|payable\s*amount/i,
  /^\W*total\b/i,
  /^\W*(net\s*)?(amount|balance)\s*due|^\W*due\s*amount/i,
];

function extractAmount(rows: string[]): number | null {
  for (const tier of TOTAL_TIERS) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const line = rows[i]!;
      if (!tier.test(line) || NOT_A_TOTAL.test(line)) continue;
      const v = lastAmount(line) ?? (rows[i + 1] ? lastAmount(rows[i + 1]!) : null);
      if (v !== null && v > 0) return v;
    }
  }
  // Nothing labelled: the biggest ₹/Rs amount, else the biggest decimal amount on the page.
  let best: number | null = null;
  for (const line of rows) {
    if (!/₹|rs\.?|inr/i.test(line) || NOT_A_TOTAL.test(line)) continue;
    for (const v of amountsIn(line)) if (best === null || v > best) best = v;
  }
  if (best !== null) return best;
  for (const line of rows) for (const m of line.matchAll(/\b\d{1,3}(?:,\d{2,3})*\.\d{2}\b/g)) { const v = parseFloat(m[0].replace(/,/g, "")); if (best === null || v > best) best = v; }
  return best;
}

function extractTax(rows: string[]): number {
  // Components (CGST/SGST/IGST/cess): the biggest figure per type, so a repeated HSN summary table isn't added twice.
  const comp: Record<string, number> = {};
  let labelled = 0;
  for (const line of rows) {
    if (/gstin|gst\s*(no|number|reg)/i.test(line)) continue;
    const m = line.match(/\b(cgst|sgst|utgst|igst|cess)\b/i);
    const v = lastAmount(line);
    if (m && v !== null) { const k = m[1]!.toLowerCase().replace("utgst", "sgst"); comp[k] = Math.max(comp[k] ?? 0, v); continue; }
    if (/^\W*(total\s*(tax|gst)|tax\s*amount|gst\s*amount|total\s*gst|gst|tax)\b/i.test(line) && v !== null) labelled = Math.max(labelled, v);
  }
  const sum = Object.values(comp).reduce((a, b) => a + b, 0);
  return Math.round(Math.max(sum, labelled) * 100) / 100;
}

function extractGSTIN(text: string): string {
  return text.match(GSTIN_PATTERN)?.[1] ?? "";
}

const DATE_FINDERS: RegExp[] = [
  /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\b/,
  /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/,
  /\b(\d{1,2}(?:st|nd|rd|th)?[\s-]*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,-]*\d{2,4})\b/i,
  /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})\b/i,
];
const INVOICE_DATE_LABEL = /(invoice|bill|tax\s*invoice|document|issue|receipt)\s*(date|dt)|date\s*of\s*(issue|invoice)|\bdated\b/i;
const BARE_DATE_LABEL = /^\W*(date|dt)\b/i;
const NOT_THE_INVOICE_DATE = /\b(due|payable\s*by|delivery|order|po|ship|dispatch|ack|irn|valid|expiry|expires|period|supply|reading|from|to)\b/i;

function datesIn(line: string): string[] {
  const out: string[] = [];
  for (const re of DATE_FINDERS) for (const m of line.matchAll(new RegExp(re.source, re.flags + "g"))) { const d = parseDate(m[1]); if (d && !out.includes(d)) out.push(d); }
  return out;
}

function extractDate(rows: string[]): string {
  const tiers: ((line: string) => boolean)[] = [
    (l) => INVOICE_DATE_LABEL.test(l) && !/\b(due|delivery|ack|irn)\b/i.test(l),
    (l) => BARE_DATE_LABEL.test(l) && !NOT_THE_INVOICE_DATE.test(l),
    (l) => !NOT_THE_INVOICE_DATE.test(l),
    () => true,
  ];
  for (const tier of tiers) {
    for (let i = 0; i < rows.length; i++) {
      if (!tier(rows[i]!)) continue;
      const d = datesIn(rows[i]!)[0] ?? (tier === tiers[0] && rows[i + 1] ? datesIn(rows[i + 1]!)[0] : undefined);
      if (d) return d;
    }
  }
  return "";
}

const INVOICE_NO_LABEL = /(?:invoice|inv|bill|receipt|voucher|document|tax\s*invoice)\s*(?:no\b|number\b|num\b|#)\.?\s*[:\-#.]*\s*([A-Z0-9][A-Z0-9/\-_.]{1,40})/i;
function extractInvoiceNumber(rows: string[]): string {
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]!.match(INVOICE_NO_LABEL);
    if (m && /\d/.test(m[1]!) && !/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(m[1]!)) return m[1]!.replace(/[.,;]+$/, "").slice(0, 128);
    // label alone on its line, value on the next
    if (/(?:invoice|bill|voucher)\s*(?:no|number|#)\.?\s*:?\s*$/i.test(rows[i]!) && rows[i + 1]) { const v = rows[i + 1]!.trim().match(/^([A-Z0-9][A-Z0-9/\-_.]{1,40})/i); if (v && /\d/.test(v[1]!)) return v[1]!; }
  }
  return "";
}

const HEADER_LINE = /^\W*(?:original|duplicate|triplicate)?(?:\s*for\s*\w+(?:\s+\w+)?)?\W*$|^\W*(?:tax\s*invoice|invoice|receipt|bill\s*of\s*supply|cash\s*memo|cash\s*bill|proforma(?:\s*invoice)?|e-?\s*invoice|credit\s*note|debit\s*note|estimate|quotation)\W*(?:\(.*\))?\W*$/i;
const CONTACT_LINE = /\b(phone|ph|tel|mob|mobile|email|e-mail|fax|www|gstin|gst\s*no|pan|cin|irn|ack)\b|@|\d{8,}/i;
function extractVendor(rows: string[]): string {
  const cap = (s: string) => (s.length > 255 ? s.slice(0, 255) : s);
  for (const line of rows.slice(0, 10)) {
    if (line.length < 3 || /^\d/.test(line) || HEADER_LINE.test(line) || CONTACT_LINE.test(line)) continue;
    return cap(line);
  }
  return rows[0] ? cap(rows[0]) : "";
}

function roundTo4(f: number): number {
  return Math.round(f * 10000) / 10000;
}

// lines=[] (unsupported browser, or an ingestion channel with no
// browser at all — WhatsApp/email) is a valid, expected input, not an
// error: it produces an explicit "OCR didn't run" result rather than
// throwing, so callers always get something to persist and the
// document surfaces cleanly for manual correction.
export function processDocument(lines: OcrLine[]): OCRResult {
  if (lines.length === 0) {
    return { ocrAvailable: false, vendorName: "", documentDate: "", rawTotalAmount: 0, taxAmount: 0, taxIdentifier: "", invoiceNumber: "", rawText: "", confidence: 0 };
  }

  let rawText = "";
  let confidenceSum = 0;
  for (const line of lines) {
    rawText += line.text + "\n";
    confidenceSum += line.confidence;
  }
  const avgConfidence = confidenceSum / lines.length;

  const rows = lines.map((l) => l.text.trim()).filter((t) => t !== "");
  const totalAmount = extractAmount(rows) ?? 0;
  const gstin = extractGSTIN(rawText);
  const vendor = extractVendor(rows);
  const docDate = extractDate(rows);
  const taxAmount = extractTax(rows);
  const invoiceNumber = extractInvoiceNumber(rows);

  return {
    ocrAvailable: true,
    vendorName: vendor,
    documentDate: docDate,
    rawTotalAmount: totalAmount,
    taxAmount,
    taxIdentifier: gstin,
    invoiceNumber,
    rawText: rawText.slice(0, 5000),
    confidence: roundTo4(avgConfidence),
  };
}

// Parses and sanity-checks the `ocr_lines` form field the browser
// sends alongside the file upload. Returns null (never throws) on
// anything malformed, so a bad/tampered payload degrades to "no OCR"
// rather than a 500 or a crash — same posture as an empty lines array.
export function parseOcrLines(raw: string | null | undefined): OcrLine[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const lines: OcrLine[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" && item !== null &&
      typeof (item as Record<string, unknown>).text === "string" &&
      typeof (item as Record<string, unknown>).confidence === "number"
    ) {
      const text = (item as { text: string }).text.slice(0, 2000);
      const confidence = Math.max(0, Math.min(1, (item as { confidence: number }).confidence));
      if (text.trim() !== "") lines.push({ text, confidence });
    }
    if (lines.length >= 500) break; // sane upper bound, mirrors the 15MB file-size cap's spirit
  }
  return lines.length > 0 ? lines : null;
}
