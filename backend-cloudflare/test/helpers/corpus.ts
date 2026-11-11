// Synthetic-but-realistic accounting corpus with GROUND TRUTH, plus renderers that lay the same
// canonical data out the way real Indian banks / accounting packages / the GST portal export it.
// Renderers return the row grid the browser parser would hand to the backend (strings, numbers,
// Date objects and Excel serials all appear, as they do after CSV vs XLSX parsing).

export function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const VENDORS: { name: string; gstin: string; short: string }[] = [
  { name: "Acme Traders Pvt Ltd", gstin: "27AAACA1234F1Z5", short: "ACME TRADERS" },
  { name: "Sharma Steel Works", gstin: "08AABCS5678K1Z2", short: "SHARMA STEEL" },
  { name: "Bharat Packaging Co", gstin: "24AABCB9012P1ZV", short: "BHARAT PACKAGING" },
  { name: "Kiran Logistics LLP", gstin: "29AAFFK3456L1Z9", short: "KIRAN LOGISTICS" },
  { name: "Om Sai Enterprises", gstin: "27AAECO7890D1ZK", short: "OM SAI ENTERPRISES" },
  { name: "Delta Office Supplies", gstin: "07AABCD2345E1Z3", short: "DELTA OFFICE" },
  { name: "Patel Chemicals Ltd", gstin: "24AAACP6789C1Z8", short: "PATEL CHEMICALS" },
  { name: "Greenfield Agro Pvt Ltd", gstin: "09AAACG0123H1ZQ", short: "GREENFIELD AGRO" },
  { name: "Sunrise Electricals", gstin: "33AABCS4567R1Z6", short: "SUNRISE ELECTRICALS" },
  { name: "Vikram Textiles", gstin: "27AAACV8901M1Z1", short: "VIKRAM TEXTILES" },
  { name: "Nova Print Solutions", gstin: "29AABCN2345Q1ZY", short: "NOVA PRINT" },
  { name: "Rajdhani Foods Ltd", gstin: "07AAACR6789B1Z4", short: "RAJDHANI FOODS" },
];

export const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const r2 = (n: number) => Math.round(n * 100) / 100;

export interface Inv { no: string; date: string; vendor: string; gstin: string; taxable: number; rate: number; intra: boolean; tax: number; total: number; kind: "INVOICE" | "DEBIT_NOTE" }
export interface Bk { id: string; date: string; narration: string; debit: number; credit: number; ref: string; balance: number }
export interface Ledger { invoices: Inv[]; bank: Bk[]; truth: Map<string, string | null> /* invoice no → bank id, null = unpaid */ }

export interface LedgerOpts { n: number; seed: number; unpaid?: number; tds?: number; lateMax?: number; narrationStyle?: "full" | "short" | "mixed"; debitNotes?: number; start?: string; roundAmounts?: boolean }

function narrationFor(r: () => number, v: (typeof VENDORS)[number], invNo: string, style: LedgerOpts["narrationStyle"], i: number): string {
  const nm = style === "short" || (style === "mixed" && r() < 0.5) ? v.short : v.name.toUpperCase();
  const ref = String(Math.floor(r() * 9e9) + 1e9);
  const withInv = r() < 0.35 ? ` ${invNo}` : "";
  switch (i % 7) {
    case 0: return `NEFT-HDFCN5${ref}-${nm}${withInv}`;
    case 1: return `RTGS-ICIC0000${Math.floor(r() * 90 + 10)}-${nm}-ICICR${ref}`;
    case 2: return `IMPS/P2A/${ref}/${nm.replace(/ /g, "")}/HDFC${withInv}`;
    case 3: return `UPI/${ref}/DR/${nm}/YESB/${nm.replace(/ /g, "").toLowerCase()}@ybl/Payment${withInv}`;
    case 4: return `NEFT/${ref}/${nm.slice(0, 20)}/SBIN0001234`;
    case 5: return `BIL/NEFT/${ref}/${nm}/ICIC${withInv}`;
    default: return `${nm} ${withInv}`.trim() + ` ACH D-${ref}`;
  }
}

const NOISE_NARR = ["SALARY APR 2026", "RENT TO LANDLORD", "ELECTRICITY BILL BESCOM", "GST CHALLAN PMT", "AMAZON PAY SELLER SETTLEMENT", "CASH WITHDRAWAL ATM", "INTEREST CREDIT", "BANK CHARGES SMS", "PETTY CASH", "DIVIDEND"];

export function makeLedger(o: LedgerOpts): Ledger {
  const r = rng(o.seed);
  const start = o.start ?? "2026-04-01";
  const invoices: Inv[] = []; const bank: Bk[] = []; const truth = new Map<string, string | null>();
  const used = new Set<string>();
  for (let i = 0; i < o.n; i++) {
    const v = VENDORS[Math.floor(r() * VENDORS.length)]!;
    const rate = [0.05, 0.12, 0.18, 0.28][Math.floor(r() * 4)]!;
    let taxable = o.roundAmounts ? [10000, 25000, 50000][Math.floor(r() * 3)]! : r2(1500 + r() * 80000);
    let key = `${v.name}|${taxable}`; while (used.has(key) && !o.roundAmounts) { taxable = r2(taxable + 0.37); key = `${v.name}|${taxable}`; } used.add(key);
    const intra = r() < 0.6; const tax = r2(taxable * rate); const total = r2(taxable + tax);
    const no = `${["INV", "BL", "PO/", "TX-"][i % 4]}${2026000 + i}`;
    const date = addDays(start, Math.floor(r() * 75));
    const kind: Inv["kind"] = r() < (o.debitNotes ?? 0) ? "DEBIT_NOTE" : "INVOICE";
    invoices.push({ no, date, vendor: v.name, gstin: v.gstin, taxable, rate, intra, tax, total, kind });
    if (kind === "DEBIT_NOTE") { truth.set(no, null); continue; }
    if (r() < (o.unpaid ?? 0.15)) { truth.set(no, null); continue; }
    const net = r() < (o.tds ?? 0) ? r2(total * 0.98) : total;
    const delay = Math.floor(r() * ((o.lateMax ?? 30) + 1));
    const id = `bk${i}`;
    bank.push({ id, date: addDays(date, delay), narration: narrationFor(r, v, no, o.narrationStyle ?? "mixed", i), debit: net, credit: 0, ref: `${Math.floor(r() * 9e11) + 1e11}`, balance: 0 });
    truth.set(no, id);
  }
  for (let k = 0; k < Math.ceil(o.n / 3); k++) {
    const credit = r() < 0.4;
    const amt = r2(300 + r() * 70000);
    bank.push({ id: `noise${k}`, date: addDays(start, Math.floor(r() * 120)), narration: `${NOISE_NARR[k % NOISE_NARR.length]} ${Math.floor(r() * 9999)}`, debit: credit ? 0 : amt, credit: credit ? amt : 0, ref: `${Math.floor(r() * 9e11) + 1e11}`, balance: 0 });
  }
  bank.sort((a, b) => a.date.localeCompare(b.date));
  let bal = 500000;
  for (const b of bank) { bal = r2(bal - b.debit + b.credit); b.balance = bal; }
  return { invoices, bank, truth };
}

// ── formatting helpers ──────────────────────────────────────────────────
export function inr(n: number): string { // Indian digit grouping: 1,18,000.00
  const [i, d] = Math.abs(n).toFixed(2).split(".");
  const last3 = i!.slice(-3); const rest = i!.slice(0, -3);
  const g = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return `${n < 0 ? "-" : ""}${g}.${d}`;
}
const [Y, M, D] = [(s: string) => s.slice(0, 4), (s: string) => s.slice(5, 7), (s: string) => s.slice(8, 10)];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULLMON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const fmt = {
  dmySlash: (s: string) => `${D(s)}/${M(s)}/${Y(s)}`,
  dmySlash2: (s: string) => `${D(s)}/${M(s)}/${Y(s).slice(2)}`,
  dmyDash: (s: string) => `${D(s)}-${M(s)}-${Y(s)}`,
  dMonY: (s: string) => `${+D(s)} ${MON[+M(s) - 1]} ${Y(s)}`,
  ddMonYY: (s: string) => `${D(s)}-${MON[+M(s) - 1]}-${Y(s).slice(2)}`,
  monDY: (s: string) => `${MON[+M(s) - 1]} ${D(s)}, ${Y(s)}`,
  longMonDY: (s: string) => `${FULLMON[+M(s) - 1]} ${+D(s)}, ${Y(s)}`,
  iso: (s: string) => s,
  isoDateTime: (s: string) => `${s}T10:22:11+05:30`,
  serial: (s: string) => Math.round(Date.parse(s + "T00:00:00Z") / 86400000) + 25569,
  dateObj: (s: string) => new Date(s + "T00:00:00Z"),
};

const blank = (n: number) => Array(n).fill("");

// ── bank statement renderers ────────────────────────────────────────────
export type BankLayout = { name: string; render: (rows: Bk[]) => unknown[][] };
export const BANK_LAYOUTS: BankLayout[] = [
  { name: "HDFC (preamble, Withdrawal Amt./Deposit Amt., dd/mm/yy, star row, summary footer)", render: (rows) => [
    ["HDFC BANK LIMITED", ...blank(6)], ["Account Branch : ANDHERI WEST", ...blank(6)], ["Statement From : 01/04/2026 To : 30/06/2026", ...blank(6)], blank(7),
    ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
    ["********", "**********************", "****************", "********", "******************", "******************", "******************"],
    ...rows.map((b) => [fmt.dmySlash2(b.date), b.narration, b.ref, fmt.dmySlash2(b.date), b.debit ? inr(b.debit) : "", b.credit ? inr(b.credit) : "", inr(b.balance)]),
    blank(7), ["STATEMENT SUMMARY :-", ...blank(6)], ["Opening Balance", "Dr Count", "Cr Count", "Debits", "Credits", "Closing Bal", ""], ["45123.45", "12", "4", "250,000.55", "90,000.00", "340,000.45", ""],
  ] },
  { name: "SBI (Txn Date/Value Date, Debit/Credit, '5 Apr 2026', blank cells as spaces)", render: (rows) => [
    ["Account Name :", "M/S EXAMPLE TRADERS", "", "", "", "", ""], ["Account Number :", "'00000012345678901", "", "", "", "", ""], blank(7),
    ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
    ...rows.map((b) => [fmt.dMonY(b.date), fmt.dMonY(b.date), b.narration, b.ref, b.debit ? inr(b.debit) : " ", b.credit ? inr(b.credit) : " ", inr(b.balance)]),
    ["", "", "Closing Balance", "", "", "", inr(rows.at(-1)?.balance ?? 0)],
  ] },
  { name: "ICICI (S No., Value Date BEFORE Transaction Date, 'Withdrawal Amount (INR )')", render: (rows) => [
    ["Transactions List - Example Traders - 000405012345 (INR) - Apr to Jun 2026", ...blank(7)], blank(8),
    ["S No.", "Value Date", "Transaction Date", "Cheque Number", "Transaction Remarks", "Withdrawal Amount (INR )", "Deposit Amount (INR )", "Balance (INR )"],
    ...rows.map((b, i) => [i + 1, fmt.dmySlash(addDays(b.date, -1)), fmt.dmySlash(b.date), "", b.narration, b.debit || 0, b.credit || 0, b.balance]),
  ] },
  { name: "Axis (SRL NO, Tran Date dd-mm-yyyy, CHQNO, PARTICULARS, DR, CR, BAL, SOL)", render: (rows) => [
    ["Name :- EXAMPLE TRADERS", ...blank(7)], ["Statement of Axis Account No :- 920020012345678 for the period (From : 01-04-2026 To : 30-06-2026)", ...blank(7)],
    ["SRL NO", "Tran Date", "CHQNO", "PARTICULARS", "DR", "CR", "BAL", "SOL"],
    ...rows.map((b, i) => [i + 1, fmt.dmyDash(b.date), "", b.narration, b.debit || "", b.credit || "", b.balance, 1234]),
  ] },
  { name: "Kotak ('Withdrawal(Dr)/Deposit(Cr)' single column with (Dr)/(Cr) suffix)", render: (rows) => [
    ["Kotak Mahindra Bank - Account Statement", ...blank(4)], blank(5),
    ["Sl. No.", "Date", "Narration", "Chq/Ref No", "Withdrawal(Dr)/Deposit(Cr)", "Balance"],
    ...rows.map((b, i) => [i + 1, fmt.dMonY(b.date), b.narration, b.ref, `${inr(b.debit || b.credit)}(${b.debit ? "Dr" : "Cr"})`, `${inr(b.balance)}(Cr)`]),
  ] },
  { name: "Neo-bank / API export (ISO datetime, single signed Amount column)", render: (rows) => [
    ["Date", "Description", "Amount", "Balance"],
    ...rows.map((b) => [fmt.isoDateTime(b.date), b.narration, b.debit ? -b.debit : b.credit, b.balance]),
  ] },
  { name: "UPI app statement (Mon DD, YYYY, Type=DEBIT/CREDIT, ₹ amounts)", render: (rows) => [
    ["Date", "Transaction Details", "Type", "Amount"],
    ...rows.map((b) => [fmt.monDY(b.date), b.narration, b.debit ? "DEBIT" : "CREDIT", `₹${inr(b.debit || b.credit)}`]),
  ] },
  { name: "XLSX typed cells (Date objects + numbers, 'Particulars', 'Debit', 'Credit')", render: (rows) => [
    ["Transaction Date", "Particulars", "Cheque No", "Debit", "Credit", "Balance"],
    ...rows.map((b) => [fmt.dateObj(b.date), b.narration, b.ref, b.debit || null, b.credit || null, b.balance]),
  ] },
  { name: "Excel serial dates, 'Dr/Cr' indicator + 'Amount' columns", render: (rows) => [
    ["Value Date", "Details", "Amount", "Dr/Cr"],
    ...rows.map((b) => [fmt.serial(b.date), b.narration, b.debit || b.credit, b.debit ? "DR" : "CR"]),
  ] },
  { name: "Headerless export (date, narration, debit, credit, balance)", render: (rows) => rows.map((b) => [fmt.dmySlash(b.date), b.narration, b.debit ? inr(b.debit) : "", b.credit ? inr(b.credit) : "", inr(b.balance)]) },
  { name: "Tally bank book (Particulars, Vch Type, Debit/Credit as receipt/payment, 1-Apr-26)", render: (rows) => [
    ["Bank Book", ...blank(5)], ["1-Apr-26 to 30-Jun-26", ...blank(5)],
    ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
    ...rows.map((b, i) => [fmt.ddMonYY(b.date), b.narration, b.debit ? "Payment" : "Receipt", i + 1, b.credit ? inr(b.credit) : "", b.debit ? inr(b.debit) : ""]),
  ] },
];
// NOTE: Tally bank book is from the *company's* books: a "Payment" is a CREDIT to bank in Tally's convention.
// The renderer above keeps Debit=receipt-side / Credit=payment-side, so the TALLY layout is verified separately.

// ── invoice register renderers ──────────────────────────────────────────
export interface InvLayout { name: string; render: (rows: Inv[]) => unknown[][]; keepsGstin: boolean; hasTaxSplit: boolean }
const taxCols = (i: Inv) => (i.intra ? [0, r2(i.tax / 2), r2(i.tax / 2)] : [i.tax, 0, 0]);
export const INVOICE_LAYOUTS: InvLayout[] = [
  { name: "GSTR-2B portal Excel (two-row header, ₹ in headers, IGST/CGST/SGST)", keepsGstin: true, hasTaxSplit: true, render: (rows) => [
    ["GSTIN of supplier", "Trade/Legal name", "Invoice details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "GSTR-1/1A/IFF/GSTR-5 Period"],
    ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", ""],
    ...rows.map((i) => { const [ig, cg, sg] = taxCols(i); return [i.gstin, i.vendor, i.no, "Regular", fmt.dmyDash(i.date), i.total, "27-Maharashtra", "No", i.taxable, ig, cg, sg, 0, "Apr-26"]; }),
  ] },
  { name: "Tally purchase register (Particulars, Voucher Type, Voucher No., Gross Total, Input CGST/SGST/IGST)", keepsGstin: false, hasTaxSplit: true, render: (rows) => [
    ["Purchase Register", ...blank(8)], ["Example Traders", ...blank(8)], ["1-Apr-26 to 30-Jun-26", ...blank(8)],
    ["Date", "Particulars", "Voucher Type", "Voucher No.", "Gross Total", "Purchase", "Input CGST", "Input SGST", "Input IGST"],
    ...rows.map((i) => { const [ig, cg, sg] = taxCols(i); return [fmt.ddMonYY(i.date), i.vendor, i.kind === "DEBIT_NOTE" ? "Debit Note" : "Purchase", i.no, inr(i.total), inr(i.taxable), inr(cg), inr(sg), inr(ig)]; }),
    ["", "Grand Total", "", "", inr(rows.reduce((a, i) => a + i.total, 0)), "", "", "", ""],
  ] },
  { name: "Zoho Books bills export (Bill Date/Bill Number/Vendor Name, 'GST Identification Number (GSTIN)')", keepsGstin: true, hasTaxSplit: false, render: (rows) => [
    ["Bill Date", "Bill Number", "Vendor Name", "GST Identification Number (GSTIN)", "Sub Total", "Tax Amount", "Total", "Status"],
    ...rows.map((i) => [fmt.iso(i.date), i.no, i.vendor, i.gstin, i.taxable, i.tax, i.total, "Open"]),
  ] },
  { name: "QuickBooks-style (Date, Num, Vendor, Amount; Excel serial dates)", keepsGstin: false, hasTaxSplit: false, render: (rows) => [
    ["Date", "Type", "Num", "Vendor", "Due Date", "Amount"],
    ...rows.map((i) => [fmt.serial(i.date), "Bill", i.no, i.vendor, fmt.serial(addDays(i.date, 30)), i.total]),
  ] },
  { name: "SAP-style (Doc. Date, Reference, Name 1, Amount in LC; value in 'Amount in LC')", keepsGstin: false, hasTaxSplit: false, render: (rows) => [
    ["Posting Date", "Doc. Date", "Reference", "Name 1", "Amount in LC", "Local Currency"],
    ...rows.map((i) => [fmt.dmyDash(addDays(i.date, 1)), fmt.dmyDash(i.date), i.no, i.vendor, inr(i.total), "INR"]),
  ] },
  { name: "Simple CSV (Invoice #, Inv Date, Party, Invoice Amount; text dates 'March 5, 2026')", keepsGstin: false, hasTaxSplit: false, render: (rows) => [
    ["Invoice #", "Inv Date", "Party", "Invoice Amount"],
    ...rows.map((i) => [i.no, fmt.longMonDY(i.date), i.vendor, `₹${inr(i.total)}`]),
  ] },
  { name: "XLSX typed cells (Date objects, numeric Taxable + GST, no total column)", keepsGstin: true, hasTaxSplit: false, render: (rows) => [
    ["Supplier Name", "GSTIN", "Invoice No", "Invoice Date", "Taxable Value", "GST"],
    ...rows.map((i) => [i.vendor, i.gstin, i.no, fmt.dateObj(i.date), i.taxable, i.tax]),
  ] },
  { name: "Headerless (invoice no, date, vendor, total)", keepsGstin: false, hasTaxSplit: false, render: (rows) => rows.map((i) => [i.no, fmt.dmySlash(i.date), i.vendor, inr(i.total)]) },
];
