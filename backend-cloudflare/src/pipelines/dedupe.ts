// Duplicate detection for bulk dataset uploads. The same invoice routinely arrives twice: the purchase register AND
// GSTR-2B, or the same file re-uploaded after a fix. Without this each copy becomes its own document and competes
// with the original for the same bank row, so one payment shows up as a match plus a phantom "unmatched" invoice.
import { vendorSimilarity } from "./reconciliation";

export interface InvKey { vendor: string; invoiceNo: string; total: number; date: string; gstin: string; docType: string }

const normNo = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const cents = (n: number) => Math.round(n * 100);

export function makeInvoiceDeduper(existing: InvKey[] = []) {
  const byNo = new Map<string, InvKey[]>();
  const byDateAmt = new Map<string, InvKey[]>();
  const push = (m: Map<string, InvKey[]>, k: string, v: InvKey) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  const add = (k: InvKey) => {
    const no = normNo(k.invoiceNo);
    if (no) push(byNo, `${k.docType}|${no}|${cents(k.total)}`, k);
    else push(byDateAmt, `${k.docType}|${k.date}|${cents(k.total)}`, k);
  };
  existing.forEach(add);
  return {
    // true when `k` is already known (and is NOT added); false when it is new (and is remembered).
    seen(k: InvKey): boolean {
      const no = normNo(k.invoiceNo);
      const list = no ? byNo.get(`${k.docType}|${no}|${cents(k.total)}`) : byDateAmt.get(`${k.docType}|${k.date}|${cents(k.total)}`);
      const dup = !!list?.some((e) => (k.gstin && e.gstin && k.gstin === e.gstin) || !k.vendor || !e.vendor || vendorSimilarity(k.vendor, e.vendor) >= (no ? 0.5 : 0.8) || normNo(k.vendor) === normNo(e.vendor));
      if (!dup) add(k);
      return dup;
    },
  };
}

// Bank rows have no natural key, so the identity is date + narration + both amounts (+ reference when the bank gives one).
export function bankKey(r: { date: string; narration: string; debit: number; credit: number; reference?: string }): string {
  return `${r.date}|${r.narration}|${cents(r.debit)}|${cents(r.credit)}`;
}
