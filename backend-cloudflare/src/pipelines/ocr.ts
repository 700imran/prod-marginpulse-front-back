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

const AMOUNT_PATTERNS = [
  /(?:total|grand\s*total|amount\s*due|net\s*payable)[^\d]*?([\d,]+\.?\d*)/i,
  /(?:₹|rs\.?|inr)\s*([\d,]+\.?\d*)/i,
  /([\d,]{4,}\.?\d{0,2})/,
];
const GSTIN_PATTERN = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b/;
const DATE_PATTERN_DMY = /(\d{2})[/-](\d{2})[/-](\d{4})/;
const DATE_PATTERN_YMD = /(\d{4})[/-](\d{2})[/-](\d{2})/;
const TAX_PATTERN = /(?:cgst|sgst|igst|gst|tax)[^\d]*([\d,]+\.?\d*)/i;
const INVOICE_PATTERN = /(?:invoice|inv)[^\w]*([\w/-]+)/i;
const INVOICE_HEADER_RE = /invoice|receipt|bill|tax\s*invoice/i;
const STARTS_WITH_DIGIT = /^\d/;

function extractAmount(text: string): number | null {
  for (const pat of AMOUNT_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const v = parseFloat(m[1]!.replace(/,/g, ""));
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

function extractGSTIN(text: string): string {
  return text.match(GSTIN_PATTERN)?.[1] ?? "";
}

function isValidDate(y: string, m: string, d: string): boolean {
  const yi = parseInt(y, 10), mi = parseInt(m, 10), di = parseInt(d, 10);
  return yi >= 1900 && yi <= 2100 && mi >= 1 && mi <= 12 && di >= 1 && di <= 31;
}

function extractDate(text: string): string {
  const ymd = text.match(DATE_PATTERN_YMD);
  if (ymd && isValidDate(ymd[1]!, ymd[2]!, ymd[3]!)) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const dmy = text.match(DATE_PATTERN_DMY);
  if (dmy && isValidDate(dmy[3]!, dmy[2]!, dmy[1]!)) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return "";
}

function extractVendor(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const limit = Math.min(5, lines.length);
  for (const line of lines.slice(0, limit)) {
    if (line.length > 5 && !STARTS_WITH_DIGIT.test(line) && !INVOICE_HEADER_RE.test(line)) {
      return line.length > 255 ? line.slice(0, 255) : line;
    }
  }
  if (lines.length > 0) return lines[0]!.length > 255 ? lines[0]!.slice(0, 255) : lines[0]!;
  return "";
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

  const totalAmount = extractAmount(rawText) ?? 0;
  const gstin = extractGSTIN(rawText);
  const vendor = extractVendor(rawText);
  const docDate = extractDate(rawText);

  let taxAmount = 0;
  const taxMatch = rawText.match(TAX_PATTERN);
  if (taxMatch) {
    const v = parseFloat(taxMatch[1]!.replace(/,/g, ""));
    if (!Number.isNaN(v)) taxAmount = v;
  }

  let invoiceNumber = "";
  const invMatch = rawText.match(INVOICE_PATTERN);
  if (invMatch) invoiceNumber = invMatch[1]!.slice(0, 128);

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
