// Port of internal/pipelines/ocr/ocr.go. The one deliberate architecture
// change: the Go version called AWS Lambda's Invoke API (SDK, SigV4);
// this calls the same Lambda via a Function URL instead (plain HTTPS +
// a bearer token) since a Worker has no AWS SigV4 credentials to sign
// with. Set OCR_LAMBDA_AUTH_TOKEN to match whatever auth the Function
// URL is configured with (IAM auth needs SigV4 and won't work from
// here — use Function URL auth type NONE plus this bearer token
// checked inside the Lambda itself, or put the Function URL behind
// API Gateway with a usage-plan API key instead).
//
// Everything downstream of getting raw OCR text back — all of the
// regex-based field extraction — is an exact, unchanged port: same
// patterns, same order, same fallbacks.
import type { Env } from "../config";

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

interface OcrLambdaResponse {
  lines: { text: string; confidence: number }[];
  error?: string;
}

async function invokeOCRLambda(env: Env, fileBytes: ArrayBuffer, mimeType: string): Promise<OcrLambdaResponse> {
  const fileBase64 = arrayBufferToBase64(fileBytes);
  const resp = await fetch(env.OCR_LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OCR_LAMBDA_AUTH_TOKEN}` },
    body: JSON.stringify({ file_base64: fileBase64, mime_type: mimeType }),
  });
  if (!resp.ok) throw new Error(`OCR Lambda invocation failed: HTTP ${resp.status}`);
  const out = (await resp.json()) as OcrLambdaResponse;
  if (out.error) throw new Error(`OCR processing failed: ${out.error}`);
  return out;
}

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

export async function processDocument(env: Env, fileBytes: ArrayBuffer, mimeType: string): Promise<OCRResult> {
  const resp = await invokeOCRLambda(env, fileBytes, mimeType);

  let rawText = "";
  let confidenceSum = 0;
  for (const line of resp.lines) {
    rawText += line.text + "\n";
    confidenceSum += line.confidence;
  }
  const avgConfidence = resp.lines.length > 0 ? confidenceSum / resp.lines.length : 0;

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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
