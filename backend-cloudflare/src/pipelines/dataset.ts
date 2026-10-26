// Format-agnostic tabular ingestion. The browser (or any caller) turns
// CSV / TSV / XLSX / JSON / XML / TXT into a plain `unknown[][]` grid;
// this module finds the header row, maps columns by synonym, classifies
// the dataset and normalises dates + amounts. Pure logic, no I/O, so it
// is unit-testable and shared by every upload path.

export type DatasetType = "BANK_STATEMENT" | "INVOICE_REGISTER" | "GST_RETURN" | "GENERIC";
export type Field =
  | "date" | "narration" | "vendor" | "invoiceNo" | "debit" | "credit" | "amount"
  | "drCr" | "balance" | "reference" | "gstin" | "taxable" | "tax" | "total";

const SYNONYMS: Record<Field, string[]> = {
  date: ["date", "txn date", "tran date", "transaction date", "value date", "posting date", "invoice date", "bill date", "doc date", "document date", "voucher date", "inv date", "invoice dt"],
  narration: ["narration", "description", "particulars", "remarks", "details", "transaction remarks", "transaction details", "transaction description", "txn description"],
  vendor: ["party", "party name", "vendor", "vendor name", "supplier", "supplier name", "name of supplier", "trade name", "legal name", "trade/legal name", "customer", "customer name", "ledger", "ledger name", "name"],
  invoiceNo: ["invoice no", "invoice number", "invoice no.", "inv no", "inv no.", "inv number", "bill no", "bill number", "voucher no", "voucher number", "document number", "doc no", "invoice #", "invoice num"],
  debit: ["debit", "withdrawal", "debit amount", "withdrawal amt", "withdrawal amt.", "withdrawals", "dr", "dr amount", "debits", "amount debited"],
  credit: ["credit", "deposit", "credit amount", "deposit amt", "deposit amt.", "deposits", "cr", "cr amount", "credits", "amount credited"],
  amount: ["amount", "txn amount", "transaction amount", "amt"],
  drCr: ["dr/cr", "cr/dr", "type", "transaction type", "txn type", "debit/credit"],
  balance: ["balance", "closing balance", "running balance", "available balance"],
  reference: ["utr", "utr no", "ref no", "ref no.", "reference", "reference no", "reference number", "chq no", "cheque no", "chq/ref no", "chq./ref.no.", "transaction id", "txn id", "bank reference"],
  gstin: ["gstin", "gstin of supplier", "supplier gstin", "gstin/uin", "gst no", "gst number", "gstin no"],
  taxable: ["taxable value", "taxable amount", "taxable", "net amount", "basic value", "subtotal", "sub total", "assessable value"],
  tax: ["tax", "tax amount", "total tax", "gst amount", "gst", "igst", "cgst", "sgst", "integrated tax", "central tax", "state/ut tax"],
  total: ["total", "invoice value", "invoice amount", "total amount", "gross amount", "bill amount", "invoice total", "grand total", "total value", "invoice value(₹)"],
};

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[_\s]+/g, " ").replace(/[()₹:]/g, "").trim();

export function matchField(header: unknown): Field | null {
  const h = norm(header);
  if (!h) return null;
  let best: Field | null = null;
  for (const f of Object.keys(SYNONYMS) as Field[]) if (SYNONYMS[f].includes(h)) { best = f; break; }
  return best;
}

// ── dates ───────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function validISO(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseDate(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  if (typeof raw === "number") {
    // Excel serial date (1900 system): 25569 = 1970-01-01
    if (raw > 20000 && raw < 80000) return new Date(Math.round((raw - 25569) * 86400000)).toISOString().slice(0, 10);
    return null;
  }
  const s = String(raw).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s?[AP]M)?$/i, "").replace(/T.*$/, "");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return validISO(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return validISO(+m[3]!, +m[2]!, +m[1]!); // India: DD/MM/YYYY
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/))) return validISO(2000 + +m[3]!, +m[2]!, +m[1]!);
  if ((m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{2,4})$/))) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith("sept") ? 4 : 3)];
    const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!;
    return mon ? validISO(y, mon, +m[1]!) : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(parseFloat(s));
  return null;
}

// ── amounts ─────────────────────────────────────────────────────────────
export function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw ?? "").trim();
  if (!s || s === "-" || s === "--") return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bdr\.?$/i.test(s)) { neg = true; s = s.replace(/\s*dr\.?$/i, ""); }
  else if (/\bcr\.?$/i.test(s)) s = s.replace(/\s*cr\.?$/i, "");
  s = s.replace(/(₹|rs\.?|inr)/gi, "").replace(/[,\s]/g, "");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return 0;
  return neg ? -v : v;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── header detection ────────────────────────────────────────────────────
export interface TableAnalysis {
  datasetType: DatasetType;
  headerRow: number;
  mapping: Partial<Record<Field, number>>;
  headers: string[];
  warnings: string[];
}

export function analyseTable(rows: unknown[][]): TableAnalysis | null {
  let best = { score: 0, idx: -1, mapping: {} as Partial<Record<Field, number>> };
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const mapping: Partial<Record<Field, number>> = {};
    (rows[i] ?? []).forEach((cell, idx) => {
      const f = matchField(cell);
      if (f && mapping[f] === undefined) mapping[f] = idx;
    });
    const score = Object.keys(mapping).length;
    if (score > best.score) best = { score, idx: i, mapping };
  }
  if (best.idx < 0 || best.score < 2) return null;
  const m = best.mapping;
  const warnings: string[] = [];
  let datasetType: DatasetType = "GENERIC";
  const hasMoney = m.debit !== undefined || m.credit !== undefined || m.amount !== undefined;
  if (m.date !== undefined && hasMoney && (m.narration !== undefined || m.reference !== undefined)) datasetType = "BANK_STATEMENT";
  else if (m.gstin !== undefined && m.invoiceNo !== undefined && (m.taxable !== undefined || m.tax !== undefined || m.total !== undefined)) datasetType = "GST_RETURN";
  else if ((m.total !== undefined || m.taxable !== undefined || m.amount !== undefined) && (m.vendor !== undefined || m.invoiceNo !== undefined) && m.date !== undefined) datasetType = "INVOICE_REGISTER";
  if (datasetType === "GENERIC") warnings.push("Could not classify this file as a bank statement or invoice register — check column headers (date, party/narration, amount).");
  return { datasetType, headerRow: best.idx, mapping: m, headers: (rows[best.idx] ?? []).map((c) => String(c ?? "")), warnings };
}

// ── normalised records ──────────────────────────────────────────────────
export interface BankRecord { date: string; narration: string; debit: number; credit: number; reference?: string }
export interface InvoiceRecord { date: string; vendor: string; invoiceNo: string; total: number; tax: number; gstin: string }

export interface NormalisedDataset {
  datasetType: DatasetType;
  bank: BankRecord[];
  invoices: InvoiceRecord[];
  rowsRead: number;
  rowsSkipped: number;
  warnings: string[];
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normaliseDataset(rows: unknown[][], forceType?: DatasetType): NormalisedDataset | null {
  const a = analyseTable(rows);
  if (!a) return null;
  const type = forceType ?? a.datasetType;
  const m = a.mapping;
  const out: NormalisedDataset = { datasetType: type, bank: [], invoices: [], rowsRead: 0, rowsSkipped: 0, warnings: [...a.warnings] };
  const cell = (r: unknown[], f: Field) => (m[f] === undefined ? undefined : r[m[f]!]);
  const text = (r: unknown[], f: Field) => String(cell(r, f) ?? "").trim();

  for (const r of rows.slice(a.headerRow + 1)) {
    if (!r || r.every((c) => c === "" || c == null)) continue;
    out.rowsRead++;
    const date = parseDate(cell(r, "date"));
    if (!date) { out.rowsSkipped++; continue; } // totals / footers / junk lines

    if (type === "BANK_STATEMENT") {
      let debit = 0, credit = 0;
      if (m.debit !== undefined || m.credit !== undefined) {
        debit = Math.abs(parseAmount(cell(r, "debit")));
        credit = Math.abs(parseAmount(cell(r, "credit")));
      } else if (m.amount !== undefined) {
        const signed = parseAmount(cell(r, "amount"));
        const t = text(r, "drCr").toLowerCase();
        const isDebit = /^(dr|d|debit|withdrawal)/.test(t) || (t === "" && signed < 0) || /dr\.?$/i.test(text(r, "amount"));
        if (isDebit) debit = Math.abs(signed); else credit = Math.abs(signed);
      }
      if (debit === 0 && credit === 0) { out.rowsSkipped++; continue; }
      out.bank.push({ date, narration: text(r, "narration") || text(r, "reference"), debit: round2(debit), credit: round2(credit), reference: text(r, "reference") || undefined });
    } else {
      let total = parseAmount(cell(r, "total"));
      const taxable = parseAmount(cell(r, "taxable"));
      const tax = parseAmount(cell(r, "tax"));
      if (!total && m.amount !== undefined) total = parseAmount(cell(r, "amount"));
      if (!total && taxable) total = taxable + tax;
      if (!total) { out.rowsSkipped++; continue; }
      const gstin = text(r, "gstin").toUpperCase();
      out.invoices.push({
        date, vendor: text(r, "vendor") || text(r, "narration"), invoiceNo: text(r, "invoiceNo"),
        total: round2(Math.abs(total)), tax: round2(Math.abs(tax)), gstin: GSTIN_RE.test(gstin) ? gstin : "",
      });
    }
  }
  if (out.bank.length + out.invoices.length === 0) out.warnings.push("No usable data rows found under the detected header.");
  if (out.rowsSkipped > 0) out.warnings.push(`${out.rowsSkipped} row(s) skipped (no valid date or amount).`);
  return out;
}
