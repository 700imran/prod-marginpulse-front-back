// Format-agnostic tabular ingestion. The browser (or any API client) turns CSV / TSV / XLSX /
// JSON / XML / TXT into a plain `unknown[][]` grid; this module finds the header row (single or
// two-row), maps columns by meaning, classifies the dataset, and normalises dates + amounts.
// Pure logic, no I/O, so it is unit-testable and shared by every upload path.
//
// Design rules (each one is covered by test/dataset.test.ts or test/format-matrix.test.ts):
//  * Headers are understood by MEANING (token rules), not by an exact-spelling list, so
//    "Withdrawal Amount (INR )", "Value Dt", "GST Identification Number (GSTIN)" all work.
//  * When several columns claim the same field the best-ranked wins (Transaction Date > Value Date).
//  * Several tax columns (IGST / CGST / SGST / Cess) are SUMMED, never half-counted.
//  * A numeric-looking footer cell can never become a date: Excel serials are only trusted when the
//    column is genuinely serial-typed.
//  * No header at all? Columns are inferred from the data itself and a warning says so.
//  * Direction is never guessed silently: Dr/Cr suffixes, a type column, sign, or the running
//    balance decide; if none exist the rows are treated as payments and the user is told.

export type DatasetType = "BANK_STATEMENT" | "INVOICE_REGISTER" | "GST_RETURN" | "GENERIC";
export type Field =
  | "date" | "narration" | "vendor" | "invoiceNo" | "debit" | "credit" | "amount"
  | "drCr" | "balance" | "reference" | "gstin" | "taxable" | "tax" | "total";

// ── header understanding ────────────────────────────────────────────────
const TOKEN_MAP: Record<string, string> = {
  amt: "amount", dt: "date", txn: "transaction", tran: "transaction", trans: "transaction", chq: "cheque", chk: "cheque", ref: "reference",
  vch: "voucher", inv: "invoice", withdrawals: "withdrawal", withdrawl: "withdrawal", withdrawn: "withdrawal", deposits: "deposit", debits: "debit", credits: "credit",
  num: "no", number: "no", nbr: "no", particular: "particulars", desc: "description", doc: "document", curr: "currency", sgst: "sgst", utgst: "sgst",
  rs: "", inr: "", rupees: "", of: "", the: "", in: "", for: "", and: "", lc: "", uin: "",
};

export function headerTokens(raw: unknown): string[] {
  const s = String(raw ?? "").toLowerCase().replace(/₹/g, " ").replace(/#/g, " no ").replace(/%/g, " percent ");
  return s.split(/[^a-z0-9]+/).filter(Boolean).map((t) => (t in TOKEN_MAP ? TOKEN_MAP[t]! : t)).filter(Boolean);
}

interface Class { field: Field; rank: number; component?: boolean; totalTax?: boolean; sales?: boolean; books?: boolean }

const has = (T: string[], ...w: string[]) => w.some((x) => T.includes(x));
const SPECIAL_TAX = ["igst", "cgst", "sgst", "cess"];

export function classifyHeader(raw: unknown): Class | null {
  const T = headerTokens(raw);
  if (T.length === 0 || T.length > 8 || String(raw).length > 60) return null;
  const t = T.join(" ");
  const rawLower = String(raw ?? "").toLowerCase().trim();

  if (rawLower === "num") return { field: "invoiceNo", rank: 2 };
  if (/^(s|sl|sr|srl|serial)( no)?$|^no$|^sno$|^index$|^#$/.test(t)) return null;
  if (has(T, "balance")) return { field: "balance", rank: 1 };
  if (has(T, "gstin", "ctin") || (has(T, "gst") && has(T, "identification", "no"))) return { field: "gstin", rank: 3 };

  // type / direction indicator columns
  if (/^(dr cr|cr dr|debit credit|credit debit|type|indicator|debit credit indicator)$/.test(t)) return { field: "drCr", rank: 3 };
  if (/ type$/.test(t) && has(T, "transaction", "voucher", "document", "note", "invoice", "entry", "txn")) return { field: "drCr", rank: 3, books: has(T, "voucher") };

  // dates
  if (has(T, "date")) {
    if (has(T, "due", "expiry", "period", "filing", "irn", "original", "maturity", "entry")) return null;
    if (has(T, "invoice", "bill", "document", "voucher", "note")) return { field: "date", rank: 6 };
    if (has(T, "transaction")) return { field: "date", rank: 5 };
    if (T.length === 1) return { field: "date", rank: 4 };
    if (has(T, "posting")) return { field: "date", rank: 3 };
    if (has(T, "payment")) return { field: "date", rank: 3 };
    if (has(T, "value")) return { field: "date", rank: 2 };
    return { field: "date", rank: 1 };
  }

  // references (bank side) before invoice numbers
  if (has(T, "cheque", "utr", "instrument", "rrn") || (has(T, "transaction") && has(T, "id")) || (has(T, "bank") && has(T, "reference"))) return { field: "reference", rank: 3 };
  if (has(T, "no") && has(T, "invoice", "bill", "voucher", "document", "note", "purchase")) {
    if (has(T, "original")) return null;
    return { field: "invoiceNo", rank: has(T, "invoice", "bill") ? 5 : 3 };
  }
  if (t === "reference" || t === "reference no") return { field: "reference", rank: 2 };
  if (t === "invoice" || t === "bill") return { field: "invoiceNo", rank: 2 };

  // money
  const hasDr = has(T, "debit", "withdrawal") || t === "dr" || /^dr /.test(t);
  const hasCr = has(T, "credit", "deposit") || t === "cr" || /^cr /.test(t) || (has(T, "dr") && has(T, "cr"));
  const NOT_MONEY = has(T, "note", "days", "limit", "count", "terms", "rating", "card", "rate", "percent", "slab", "code", "id", "category", "treatment", "type", "status", "registration");
  if (!NOT_MONEY) {
    if ((hasDr && hasCr) && !(t === "dr cr" || t === "cr dr")) return { field: "amount", rank: 2 }; // "Withdrawal(Dr)/Deposit(Cr)"
    if (hasDr) return { field: "debit", rank: 3 };
    if (hasCr) return { field: "credit", rank: 3 };
  }
  const taxish = has(T, ...SPECIAL_TAX) || ((has(T, "tax", "gst")) && !has(T, "rate", "percent", "type", "treatment", "no", "id", "registration", "category", "code", "slab", "number", "identification"));
  if (taxish) {
    if (has(T, "taxable", "assessable")) return { field: "taxable", rank: 4 };
    if (has(T, "reverse", "charge", "place", "supply", "applicable", "availability")) return null;
    const totalTax = /^(tax|total tax|tax amount|gst amount|gst|total gst|tax total|gst total|total tax amount)$/.test(t);
    return { field: "tax", rank: totalTax ? 4 : 2, component: !totalTax, totalTax };
  }
  if (has(T, "taxable", "assessable", "subtotal", "basic") || t === "sub total" || t === "net amount" || t === "net value" || t === "purchase" || t === "purchases" || t === "purchase accounts" || t === "purchase value") return { field: "taxable", rank: 4 };
  if (has(T, "total", "gross", "grand", "payable") || (has(T, "invoice", "bill", "note") && has(T, "value", "amount", "total")) ) return { field: "total", rank: has(T, "invoice", "bill", "gross", "grand") ? 5 : 4 };
  if (has(T, "amount", "value")) return { field: "amount", rank: 1 };

  // parties
  if (has(T, "code", "id", "address", "state", "city", "pincode", "phone", "email", "pan")) return null;
  if (has(T, "vendor", "supplier", "party", "payee", "beneficiary", "ledger", "customer", "buyer", "trade", "legal") || t === "name" || /^name \d$/.test(t) || has(T, "name")) {
    if (has(T, "bank", "branch", "account", "file", "sheet")) return null;
    return { field: "vendor", rank: has(T, "vendor", "supplier", "party", "trade", "legal") ? 4 : 2, sales: has(T, "customer", "buyer", "recipient") };
  }
  if (has(T, "narration", "description", "particulars", "remarks", "details", "narrative", "memo", "remark")) return { field: "narration", rank: 3 };
  return null;
}

// Back-compat for callers/tests that want the field only.
export function matchField(header: unknown): Field | null { return classifyHeader(header)?.field ?? null; }

// ── dates ───────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthOf = (w: string) => MONTHS[w.toLowerCase().slice(0, 3)];

function validISO(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface DateCtx { order: "dmy" | "mdy"; serial: boolean }
const DEFAULT_CTX: DateCtx = { order: "dmy", serial: true };
const SERIAL_MIN = 32874; // 1990-01-01
const SERIAL_MAX = 73415; // 2100-12-31

function fromSerial(n: number): string | null {
  if (!(n >= SERIAL_MIN && n <= SERIAL_MAX)) return null;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export function parseDateCtx(raw: unknown, ctx: DateCtx = DEFAULT_CTX): string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : validISO(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  if (typeof raw === "number") return ctx.serial ? fromSerial(raw) : null;
  const s = String(raw).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s?[AP]M)?(\s?(Z|[+-]\d{2}:?\d{2}|IST))?$/i, "").replace(/T\d.*$/, "").replace(/(\d)(st|nd|rd|th)\b/i, "$1");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return validISO(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return validISO(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return ctx.order === "mdy" ? validISO(+m[3]!, +m[1]!, +m[2]!) : validISO(+m[3]!, +m[2]!, +m[1]!);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/))) return ctx.order === "mdy" ? validISO(2000 + +m[3]!, +m[1]!, +m[2]!) : validISO(2000 + +m[3]!, +m[2]!, +m[1]!);
  if ((m = s.match(new RegExp(`^(\\d{1,2})[-/ .]*${MONTH_WORD}[-/ .,']*(\\d{2,4})$`, "i")))) { const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!; return validISO(y, monthOf(m[2]!)!, +m[1]!); }
  if ((m = s.match(new RegExp(`^${MONTH_WORD}[-/ .]*(\\d{1,2})[-/ .,']+(\\d{2,4})$`, "i")))) { const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!; return validISO(y, monthOf(m[1]!)!, +m[2]!); }
  if (ctx.serial && /^\d{5}(\.\d+)?$/.test(s)) return fromSerial(parseFloat(s));
  return null;
}
export function parseDate(raw: unknown): string | null { return parseDateCtx(raw, DEFAULT_CTX); }

// Decide, from the whole column, how its dates are written. Cheap and deterministic.
function dateContext(values: unknown[]): DateCtx {
  let numeric = 0, text = 0, aOver12 = 0, bOver12 = 0;
  for (const v of values) {
    if (v == null || v === "") continue;
    if (typeof v === "number") { numeric++; continue; }
    if (v instanceof Date) continue;
    const s = String(v).trim();
    if (/^\d{5}(\.\d+)?$/.test(s)) { numeric++; continue; }
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) { text++; if (+m[1]! > 12) aOver12++; if (+m[2]! > 12) bOver12++; } else if (parseDateCtx(s, { order: "dmy", serial: false })) text++;
  }
  return { order: bOver12 > 0 && aOver12 === 0 ? "mdy" : "dmy", serial: numeric > 0 && numeric >= text };
}

// ── amounts ─────────────────────────────────────────────────────────────
export function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw ?? "").trim();
  if (!s || /^(-|--|—|nil|n\/a|na|null)$/i.test(s)) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/[\s(]*\(?\bdr\b\.?\)?$/i.test(s) || /\(dr\)$/i.test(s)) { neg = true; s = s.replace(/\s*\(?\bdr\b\.?\)?$/i, ""); }
  else if (/\(?\bcr\b\.?\)?$/i.test(s)) s = s.replace(/\s*\(?\bcr\b\.?\)?$/i, "");
  s = s.replace(/(₹|rs\.?|inr)/gi, "").replace(/\/-$/, "").replace(/[,\s]/g, "").replace(/[−–]/g, "-");
  if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); } // SAP-style trailing minus
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return 0;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return 0;
  return neg ? -v : v;
}
const looksNumeric = (v: unknown) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && /\d/.test(v) && parseAmount(v) !== 0 && /^[\s₹rsinr.(),+\-−0-9/]*(dr|cr)?\.?\)?\s*$/i.test(v.trim().replace(/\/-$/, "")));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── header detection ────────────────────────────────────────────────────
export interface TableAnalysis {
  datasetType: DatasetType;
  headerRow: number; // index of the LAST header row (data starts after it)
  mapping: Partial<Record<Field, number>>;
  taxCols: number[];
  headers: string[];
  warnings: string[];
  booksView: boolean; // Tally-style books ledger: Debit/Credit are from the company's side
  salesHint: boolean;
  inferred: boolean;
}

interface HeaderCandidate { score: number; last: number; mapping: Partial<Record<Field, number>>; taxCols: number[]; headers: string[]; books: boolean; sales: boolean }

const cellStr = (c: unknown) => (c == null ? "" : String(c).trim());
const isDataLike = (c: unknown) => c instanceof Date || (typeof c === "number") || (cellStr(c) !== "" && (parseDateCtx(c, { order: "dmy", serial: false }) !== null || looksNumeric(c)));

function candidateFromHeaders(headers: string[], last: number): HeaderCandidate {
  const best = new Map<Field, { idx: number; rank: number }>();
  const taxComponents: number[] = []; const taxTotals: number[] = [];
  let books = false, sales = false;
  headers.forEach((h, idx) => {
    const c = classifyHeader(h);
    if (!c) return;
    if (c.books) books = true;
    if (c.sales) sales = true;
    if (c.field === "tax") { (c.totalTax ? taxTotals : taxComponents).push(idx); }
    const cur = best.get(c.field);
    if (!cur || c.rank > cur.rank) best.set(c.field, { idx, rank: c.rank });
  });
  const mapping: Partial<Record<Field, number>> = {};
  for (const [f, v] of best) mapping[f] = v.idx;
  const taxCols = taxTotals.length ? [taxTotals[0]!] : taxComponents;
  return { score: best.size, last, mapping, taxCols, headers, books, sales };
}

function rowText(r: unknown[] | undefined) { return (r ?? []).map(cellStr); }

function findHeader(rows: unknown[][]): HeaderCandidate | null {
  let best: HeaderCandidate | null = null;
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const r = rows[i] ?? [];
    if (r.filter(isDataLike).length > 2) continue; // a data row can't be a header
    const single = candidateFromHeaders(rowText(r), i);
    if (single.score >= 2 && (!best || single.score > best.score)) best = single;
    const next = rows[i + 1];
    if (next && next.some((c) => cellStr(c) !== "") && next.filter(isDataLike).length === 0) {
      const a = rowText(r); const b = rowText(next);
      const combined = candidateFromHeaders(a.map((x, k) => (b[k] ? b[k]! : x)).concat(b.slice(a.length)), i + 1);
      if (combined.score >= 3 && combined.score > (best?.score ?? 0) && combined.score > single.score) best = combined;
    }
  }
  return best;
}

// NB: a bare "GSTR-1" is NOT a sales signal — every GSTR-2B / 2A carries a "GSTR-1/1A/IFF/GSTR-5 Period" column
// (the period in which the SUPPLIER filed). Outward-supply files are caught by their wording or by recipient/customer headers.
const SALES_PREAMBLE = /sales\s+register|sale\s+register|outward\s+suppl|sales\s+invoice|receivable/i;

export function analyseTable(rows: unknown[][]): TableAnalysis | null {
  const warnings: string[] = [];
  const hdr = findHeader(rows);
  const preamble = rows.slice(0, hdr ? hdr.last : 8).flat().map(cellStr).join(" ");
  const salesHint = SALES_PREAMBLE.test(preamble) || !!hdr?.sales;
  if (!hdr) return inferTable(rows);
  const m = hdr.mapping;
  const money = m.debit !== undefined || m.credit !== undefined || m.amount !== undefined;
  const both = m.debit !== undefined && m.credit !== undefined;
  const bank = (both ? 5 : 0) + (m.debit !== undefined || m.credit !== undefined ? 2 : 0) + (m.amount !== undefined && m.drCr !== undefined ? 2 : 0) + (m.narration !== undefined ? 2 : 0) + (m.balance !== undefined ? 2 : 0) + (m.reference !== undefined && m.invoiceNo === undefined ? 1 : 0);
  const inv = (m.invoiceNo !== undefined ? 3 : 0) + (m.vendor !== undefined ? 2 : 0) + (m.gstin !== undefined ? 3 : 0) + (m.total !== undefined || m.taxable !== undefined ? 2 : 0) + (hdr.taxCols.length ? 1 : 0) + (m.reference !== undefined && m.invoiceNo === undefined && m.vendor !== undefined ? 1 : 0);
  let datasetType: DatasetType = "GENERIC";
  if (m.date !== undefined && money && bank >= 4 && bank > inv) datasetType = "BANK_STATEMENT";
  else if (m.date !== undefined && (m.total !== undefined || m.taxable !== undefined || m.amount !== undefined) && (m.vendor !== undefined || m.invoiceNo !== undefined || m.gstin !== undefined || m.reference !== undefined || m.narration !== undefined) && inv >= 3) datasetType = m.gstin !== undefined && m.invoiceNo !== undefined ? "GST_RETURN" : "INVOICE_REGISTER";
  else if (m.date !== undefined && money && bank >= 2) datasetType = "BANK_STATEMENT";
  if (datasetType === "GENERIC") {
    const inferred = inferTable(rows);
    if (inferred && inferred.datasetType !== "GENERIC") return inferred;
    warnings.push("Could not classify this file as a bank statement or invoice register — check column headers (date, party/narration, amount).");
  }
  if (salesHint && datasetType !== "BANK_STATEMENT") warnings.push("This looks like a SALES / receivables register (customer invoices). Customer receipts are not reconciled yet, so these invoices are treated as purchase invoices — upload your purchase register or GSTR-2B for payables reconciliation.");
  return { datasetType, headerRow: hdr.last, mapping: m, taxCols: hdr.taxCols, headers: hdr.headers, warnings, booksView: hdr.books && m.debit !== undefined && m.credit !== undefined, salesHint, inferred: false };
}

// ── header-less files: infer the columns from the data itself ──────────────
function inferTable(rows: unknown[][]): TableAnalysis | null {
  const data = rows.filter((r) => r && r.some((c) => cellStr(c) !== ""));
  if (data.length < 3) return null;
  const sample = data.slice(0, 400);
  const width = Math.max(...sample.map((r) => r.length));
  const col = (i: number) => sample.map((r) => r[i]);
  const filled = (i: number) => col(i).filter((c) => cellStr(c) !== "");
  const stats = Array.from({ length: width }, (_, i) => {
    const f = filled(i); const n = f.length || 1;
    const ctx = dateContext(f);
    const dateHits = f.filter((c) => parseDateCtx(c, ctx) !== null && !(typeof c === "number" && !ctx.serial)).length;
    const numHits = f.filter(looksNumeric).length;
    const avgLen = f.reduce<number>((a, c) => a + cellStr(c).length, 0) / n;
    const unique = new Set(f.map(cellStr)).size / n;
    return { i, filled: f.length, dateRate: dateHits / n, numRate: numHits / n, avgLen, unique, ctx, hasDigit: f.filter((c) => /\d/.test(cellStr(c))).length / n };
  });
  const dateCol = stats.filter((s) => s.dateRate >= 0.8 && s.filled >= sample.length * 0.6).sort((a, b) => b.dateRate - a.dateRate || a.i - b.i)[0];
  if (!dateCol) return null;
  const nums = stats.filter((s) => s.i !== dateCol.i && s.numRate >= 0.6 && s.dateRate < 0.5 && s.filled >= 2);
  const textCols = stats.filter((s) => s.i !== dateCol.i && s.numRate < 0.5 && s.avgLen >= 3);
  const narr = [...textCols].sort((a, b) => b.avgLen - a.avgLen)[0];
  if (!narr || nums.length === 0) return null;
  const mapping: Partial<Record<Field, number>> = { date: dateCol.i, narration: narr.i };
  const warnings = ["No header row was found, so the columns were inferred from the data (date, description and amounts). Please check the result."];

  // invoice list: a short, mostly-unique alphanumeric id column + a longer name column
  const idCol = textCols.find((s) => s.i !== narr.i && s.unique >= 0.9 && s.avgLen <= 24 && s.hasDigit >= 0.9);
  const exclusive = (a: number, b: number) => { let both = 0, one = 0; for (const r of sample) { const x = parseAmount(r[a]) !== 0, y = parseAmount(r[b]) !== 0; if (x && y) both++; else if (x || y) one++; } return one > 0 && both / (one + both) < 0.05; };
  if (idCol) {
    mapping.invoiceNo = idCol.i; mapping.vendor = narr.i; delete mapping.narration; mapping.total = nums[nums.length - 1]!.i;
    return { datasetType: "INVOICE_REGISTER", headerRow: -1, mapping, taxCols: [], headers: [], warnings, booksView: false, salesHint: false, inferred: true };
  }
  if (nums.length >= 2 && exclusive(nums[0]!.i, nums[1]!.i)) {
    mapping.debit = nums[0]!.i; mapping.credit = nums[1]!.i; if (nums[2]) mapping.balance = nums[2].i;
    warnings.push("Columns were read as: debit = first amount column, credit = second. If this is reversed, re-upload with a header row.");
  } else {
    mapping.amount = nums[0]!.i; if (nums[1]) mapping.balance = nums[1].i;
  }
  return { datasetType: "BANK_STATEMENT", headerRow: -1, mapping, taxCols: [], headers: [], warnings, booksView: false, salesHint: false, inferred: true };
}

// ── normalised records ──────────────────────────────────────────────────
export interface BankRecord { date: string; narration: string; debit: number; credit: number; reference?: string }
export interface InvoiceRecord { date: string; vendor: string; invoiceNo: string; total: number; tax: number; gstin: string; docType: "INVOICE" | "CREDIT_NOTE" }

export interface NormalisedDataset {
  datasetType: DatasetType;
  bank: BankRecord[];
  invoices: InvoiceRecord[];
  rowsRead: number;
  rowsSkipped: number;
  warnings: string[];
  inferred?: boolean;
  /** Customer-side (sales / outward-supply) register — the API refuses these rather than importing customers as payables. */
  salesRegister?: boolean;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DEBIT_WORD = /^(dr|d|debit|withdrawal|w|paid|sent|payment|out|pmt|purchase)\b/i;
const CREDIT_WORD = /^(cr|c|credit|deposit|received|receipt|in|rcpt|refund)\b/i;
// Tally-style ledgers / day-books mix every voucher type. Only money-movement vouchers are bank rows.
const NON_BANK_VOUCHER = /\b(sales?|purchases?|journal|jv|debit\s*note|credit\s*note|memo|stock|delivery|receipt\s*note|rejection|physical|manufactur|reversing|memorandum)\b/i;
const NOTE_WORD = /credit\s*note|debit\s*note|\bcdn[rn]?\b|credit\s*memo|\bnote\b|^c$|^d$|purchase\s*return|sales\s*return/i;

export function normaliseDataset(rows: unknown[][], forceType?: DatasetType): NormalisedDataset | null {
  const a = analyseTable(rows);
  if (!a) return null;
  const type = forceType ?? a.datasetType;
  const m = a.mapping;
  const out: NormalisedDataset = { datasetType: type, bank: [], invoices: [], rowsRead: 0, rowsSkipped: 0, warnings: [...a.warnings], inferred: a.inferred, salesRegister: a.salesHint && type !== "BANK_STATEMENT" };
  let nonBank = 0;
  const body = rows.slice(a.headerRow + 1);
  const cell = (r: unknown[], f: Field) => (m[f] === undefined ? undefined : r[m[f]!]);
  const text = (r: unknown[], f: Field) => cellStr(cell(r, f));
  const ctx = m.date !== undefined ? dateContext(body.map((r) => r?.[m.date!])) : DEFAULT_CTX;
  if (ctx.order === "mdy") out.warnings.push("Dates were read as MM/DD/YYYY (a day greater than 12 appears in the second position).");

  // Direction for single-amount bank files without a Dr/Cr column or signs: use the running balance.
  let amountDirection: "sign" | "balance" | "unknown" = "sign";
  if (type === "BANK_STATEMENT" && m.amount !== undefined && m.debit === undefined && m.credit === undefined && m.drCr === undefined) {
    const vals = body.map((r) => r?.[m.amount!]);
    const anySignal = vals.some((v) => (typeof v === "number" ? v < 0 : /^\s*[-(−]|dr\.?\)?\s*$|cr\.?\)?\s*$/i.test(String(v ?? ""))));
    if (!anySignal) {
      let agree = 0, tried = 0;
      if (m.balance !== undefined) {
        let prev: number | null = null;
        for (const r of body) { const b = parseAmount(r?.[m.balance]); const amt = Math.abs(parseAmount(r?.[m.amount]));
          if (prev !== null && amt > 0) { tried++; if (Math.abs(Math.abs(b - prev) - amt) < 0.011) agree++; } prev = b || prev; }
      }
      amountDirection = tried >= 3 && agree / tried >= 0.8 ? "balance" : "unknown";
      if (amountDirection === "unknown") out.warnings.push("This file has one Amount column with no Dr/Cr marker, no signs and no running balance, so the direction of each row is unknown — rows were treated as payments (debits).");
    }
  }

  let prevBalance: number | null = null;
  for (const r of body) {
    if (!r || r.every((c) => c === "" || c == null)) continue;
    out.rowsRead++;
    const date = parseDateCtx(cell(r, "date"), ctx);
    if (!date) { out.rowsSkipped++; continue; } // totals / footers / junk lines

    if (type === "BANK_STATEMENT") {
      if (a.booksView && NON_BANK_VOUCHER.test(text(r, "drCr"))) { nonBank++; continue; }
      let debit = 0, credit = 0;
      if (m.debit !== undefined || m.credit !== undefined) {
        debit = Math.abs(parseAmount(cell(r, "debit")));
        credit = Math.abs(parseAmount(cell(r, "credit")));
        if (a.booksView) [debit, credit] = [credit, debit]; // Tally bank book: Debit = receipt, Credit = payment
      } else if (m.amount !== undefined) {
        const raw = cell(r, "amount");
        const signed = parseAmount(raw);
        const t = text(r, "drCr");
        let isDebit: boolean;
        if (t !== "" && (DEBIT_WORD.test(t) || CREDIT_WORD.test(t))) isDebit = DEBIT_WORD.test(t) && !CREDIT_WORD.test(t);
        else if (/\(?dr\.?\)?\s*$/i.test(String(raw ?? "")) || signed < 0) isDebit = true;
        else if (/\(?cr\.?\)?\s*$/i.test(String(raw ?? ""))) isDebit = false;
        else if (amountDirection === "balance" && m.balance !== undefined) { const b = parseAmount(r[m.balance]); isDebit = prevBalance !== null && b < prevBalance; }
        else isDebit = amountDirection === "unknown";
        if (isDebit) debit = Math.abs(signed); else credit = Math.abs(signed);
      }
      if (m.balance !== undefined) { const b = parseAmount(r[m.balance]); if (b !== 0 || cellStr(r[m.balance]) !== "") prevBalance = b; }
      if (debit === 0 && credit === 0) { out.rowsSkipped++; continue; }
      out.bank.push({ date, narration: text(r, "narration") || text(r, "reference"), debit: round2(debit), credit: round2(credit), reference: text(r, "reference") || undefined });
    } else {
      let total = parseAmount(cell(r, "total"));
      const taxable = parseAmount(cell(r, "taxable"));
      const tax = a.taxCols.reduce((s, c) => s + Math.abs(parseAmount(r[c])), 0);
      if (!total && m.amount !== undefined) total = parseAmount(cell(r, "amount"));
      if (!total && taxable) total = taxable + tax;
      if (!total) { out.rowsSkipped++; continue; }
      const gstin = text(r, "gstin").toUpperCase().replace(/\s+/g, "");
      const kind = text(r, "drCr");
      const isNote = total < 0 || NOTE_WORD.test(kind) || (m.invoiceNo === undefined && NOTE_WORD.test(text(r, "narration")));
      out.invoices.push({
        date, vendor: text(r, "vendor") || text(r, "narration"), invoiceNo: text(r, "invoiceNo") || (m.reference !== undefined ? text(r, "reference") : ""),
        total: round2(Math.abs(total)), tax: round2(Math.abs(tax)), gstin: GSTIN_RE.test(gstin) ? gstin : "", docType: isNote ? "CREDIT_NOTE" : "INVOICE",
      });
    }
  }
  if (nonBank > 0) out.warnings.push(`${nonBank} non-bank voucher row(s) (Sales / Purchase / Journal …) were ignored — only payment, receipt and contra entries are bank movements.`);
  const notes = out.invoices.filter((i) => i.docType === "CREDIT_NOTE").length;
  if (notes > 0) out.warnings.push(`${notes} credit / debit note(s) were stored but are not matched against payments.`);
  if (out.bank.length + out.invoices.length === 0) out.warnings.push("No usable data rows found under the detected header.");
  if (out.rowsSkipped > 0) out.warnings.push(`${out.rowsSkipped} row(s) skipped (no valid date or amount).`);
  return out;
}

// ── multi-sheet workbooks ───────────────────────────────────────────────
// A bank workbook often has one sheet per month; a GSTR-2B workbook has B2B / B2BA / CDNR sheets plus a cover sheet.
// Every sheet is analysed on its own; sheets of the same family as the biggest one are merged, the rest are
// skipped with a note (cover pages, summaries, a stray invoice sheet inside a bank workbook, …).
const family = (t: DatasetType) => (t === "BANK_STATEMENT" ? "BANK" : t === "GENERIC" ? "NONE" : "INVOICE");

export function normaliseWorkbook(sheets: { name: string; rows: unknown[][] }[], forceType?: DatasetType): NormalisedDataset | null {
  if (sheets.length === 1) return normaliseDataset(sheets[0]!.rows, forceType);
  const parsed = sheets.map((s) => ({ name: s.name, d: normaliseDataset(s.rows, forceType) }));
  const usable = parsed.filter((x) => x.d && x.d.datasetType !== "GENERIC" && x.d.bank.length + x.d.invoices.length > 0);
  if (usable.length === 0) return parsed.find((x) => x.d)?.d ?? null;
  const size = (d: NormalisedDataset) => d.bank.length + d.invoices.length;
  const lead = [...usable].sort((a, b) => size(b.d!) - size(a.d!))[0]!;
  const same = usable.filter((x) => family(x.d!.datasetType) === family(lead.d!.datasetType));
  const merged: NormalisedDataset = { datasetType: lead.d!.datasetType, bank: [], invoices: [], rowsRead: 0, rowsSkipped: 0, warnings: [], inferred: same.some((x) => x.d!.inferred), salesRegister: same.some((x) => x.d!.salesRegister) };
  for (const x of same) {
    merged.bank.push(...x.d!.bank); merged.invoices.push(...x.d!.invoices);
    merged.rowsRead += x.d!.rowsRead; merged.rowsSkipped += x.d!.rowsSkipped;
    for (const w of x.d!.warnings) if (!/skipped \(no valid date/.test(w) && !merged.warnings.includes(`[${x.name}] ${w}`)) merged.warnings.push(`[${x.name}] ${w}`);
  }
  merged.warnings.unshift(`Read ${same.length} sheet(s): ${same.map((x) => x.name).join(", ")}.`);
  const skipped = parsed.filter((x) => !same.includes(x as any)).map((x) => x.name);
  if (skipped.length) merged.warnings.push(`Skipped sheet(s) that are not part of this dataset: ${skipped.join(", ")}.`);
  if (merged.rowsSkipped > 0) merged.warnings.push(`${merged.rowsSkipped} row(s) skipped (no valid date or amount).`);
  return merged;
}
