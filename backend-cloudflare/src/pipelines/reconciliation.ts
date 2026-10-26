// Exact port of internal/pipelines/reconciliation/reconciliation.go, which
// itself ports app/pipelines/reconciliation_engine.py's Section 2.3
// composite matching score:
//
//   S_match = w1*L(s_inv,s_bank) + w2*(1-|v_inv-v_bank|/v_inv) + w3*exp(-λ*|t_inv-t_bank|)
//
// No behavior change intended — same weights, same Levenshtein
// implementation (rune/codepoint-aware, matching rapidfuzz), same
// threshold semantics. Pure logic, zero AWS dependency in the original,
// so this is a straight transliteration rather than a redesign.

const W1 = 0.4; // string similarity weight
const W2 = 0.4; // value match weight
const W3 = 0.2; // temporal proximity weight
const LAMBDA = 0.15; // temporal decay factor

// Global defaults from config.go (RECONCILE_CONFIDENCE_THRESHOLD /
// RECONCILE_AUTO_APPROVE_THRESHOLD env vars) — these are NOT the same as
// the per-tenant reconciliation_settings row (fuzzy_vendor_matching /
// date_drift_tolerance_days / ocr_confidence_threshold), which gate OCR
// acceptance and duplicate-window logic elsewhere, not this formula.
export interface ReconcileThresholds {
  confidenceThreshold: number;
  autoApproveThreshold: number;
}
export const DEFAULT_THRESHOLDS: ReconcileThresholds = {
  confidenceThreshold: 0.85,
  autoApproveThreshold: 0.9,
};

export function levenshteinDistance(a: string, b: string): number {
  const ra = Array.from(a);
  const rb = Array.from(b);
  const la = ra.length;
  const lb = rb.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  let curr = new Array(lb + 1).fill(0);
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = ra[i - 1] === rb[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb]!;
}

// Mirrors rapidfuzz's Levenshtein.distance-based ratio: 1.0 - (edit_distance / max_len).
export function levenshteinRatio(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === "" || nb === "") return 0.0;
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - dist / maxLen;
}

function dayDelta(aISO: string, bISO: string): number | null {
  const a = Date.parse(aISO + "T00:00:00Z");
  const b = Date.parse(bISO + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round(Math.abs(a - b) / 86_400_000);
}

function roundTo6(f: number): number {
  return Math.round(f * 1_000_000) / 1_000_000;
}

export function computeMatchScore(
  invVendor: string,
  bankNarration: string,
  invAmount: number,
  bankAmount: number,
  invDateISO: string,
  bankDateISO: string,
): number {
  const stringScore = levenshteinRatio(invVendor, bankNarration);

  let valueScore = 0;
  if (invAmount > 0) {
    const valueDiffRatio = Math.abs(invAmount - bankAmount) / invAmount;
    valueScore = Math.max(0.0, 1.0 - valueDiffRatio);
  }

  const days = dayDelta(invDateISO, bankDateISO);
  const temporalScore = days !== null ? Math.exp(-LAMBDA * days) : 0.0;

  const score = W1 * stringScore + W2 * valueScore + W3 * temporalScore;
  return roundTo6(Math.min(score, 1.0));
}

export interface Invoice {
  documentId: string;
  vendorName: string;
  rawTotalAmount: number;
  documentDate: string; // ISO YYYY-MM-DD
  invoiceNumber?: string;
}
export interface BankRow {
  transactionId: string;
  narration: string;
  debitAmount: number;
  transactionDate: string;
}
export interface MatchResult {
  documentId: string;
  matchedBankTransactionId: string | null;
  score: number;
  status: "RECONCILED" | "MANUAL_REVIEW" | "UNMATCHED" | "FAILED";
  reason: string;
}

export function reconcileBatchLegacy(invoices: Invoice[], bankRows: BankRow[], thresholds: ReconcileThresholds = DEFAULT_THRESHOLDS): MatchResult[] {
  const results: MatchResult[] = [];

  for (const inv of invoices) {
    if (!inv.documentDate || inv.rawTotalAmount === 0) {
      results.push({ documentId: inv.documentId, matchedBankTransactionId: null, score: 0, status: "FAILED", reason: "Missing amount or date for matching" });
      continue;
    }

    let bestScore = 0;
    let bestMatchId: string | null = null;
    let bestNarration = "";
    for (const bank of bankRows) {
      if (!bank.transactionDate || bank.debitAmount === 0) continue;
      const score = computeMatchScore(inv.vendorName, bank.narration, inv.rawTotalAmount, bank.debitAmount, inv.documentDate, bank.transactionDate);
      if (score > bestScore) {
        bestScore = score;
        bestMatchId = bank.transactionId;
        bestNarration = bank.narration;
      }
    }

    let status: MatchResult["status"];
    let reason: string;
    if (bestScore >= thresholds.autoApproveThreshold) {
      status = "RECONCILED";
      reason = `Matched bank transaction "${bestNarration}" with confidence ${(bestScore * 100).toFixed(0)}% (>= ${(thresholds.autoApproveThreshold * 100).toFixed(0)}% auto-approve threshold)`;
    } else if (bestScore >= thresholds.confidenceThreshold) {
      status = "MANUAL_REVIEW";
      reason = `Best candidate bank transaction "${bestNarration}" scored ${(bestScore * 100).toFixed(0)}% — above the ${(thresholds.confidenceThreshold * 100).toFixed(0)}% review floor but below the ${(thresholds.autoApproveThreshold * 100).toFixed(0)}% auto-approve threshold, so needs a human check`;
    } else if (bestMatchId !== null) {
      status = "UNMATCHED";
      reason = `Closest bank transaction "${bestNarration}" only scored ${(bestScore * 100).toFixed(0)}% (below the ${(thresholds.confidenceThreshold * 100).toFixed(0)}% review floor) — vendor name, amount, or date likely don't line up`;
    } else {
      status = "UNMATCHED";
      reason = "No bank transaction found within the search window with a matching debit amount";
    }

    results.push({
      documentId: inv.documentId,
      matchedBankTransactionId: status === "RECONCILED" ? bestMatchId : null,
      score: bestScore,
      status,
      reason,
    });
  }
  return results;
}


// ════════════════════════════════════════════════════════════════════════
// v2 engine — gated, one-to-one, token-aware.
//
// Why the legacy scorer was replaced (measured in reconciliation.bench.test.ts):
//  1. Amount was a soft term, so a perfect name + date match with a 5%
//     wrong amount still scored 0.98 and auto-approved.
//  2. Whole-string Levenshtein of "ACME TRADERS" against
//     "NEFT-HDFC0001-ACME TRADERS PVT LTD-REF88213" is dominated by bank
//     noise, so true matches scored low and wrong ones high.
//  3. Invoices were scored independently, so one bank debit could be
//     "matched" to several invoices.
// ════════════════════════════════════════════════════════════════════════

const NOISE = new Set(["neft", "rtgs", "imps", "upi", "ach", "ecs", "nach", "cr", "dr", "by", "to", "from", "ref", "refno", "txn", "payment", "pmt", "pay", "transfer", "trf", "tpt", "inb", "mob", "bank", "ltd", "limited", "pvt", "private", "llp", "inc", "co", "company", "corp", "the", "and", "of", "sbin", "hdfc", "icic", "utib", "kkbk", "yesb", "pytm", "ybl", "okaxis", "oksbi", "okhdfcbank", "paytm"]);

export function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((t) => t.length > 1 && !NOISE.has(t) && !/^\d{6,}$/.test(t) && !/^[a-z]{4}0\w{6}$/.test(t));
}

// Share of the vendor's tokens that appear (exactly or with a small typo /
// truncation) in the bank narration. Containment, not whole-string distance.
export function vendorSimilarity(vendor: string, narration: string): number {
  const vt = tokens(vendor);
  const nt = tokens(narration);
  if (vt.length === 0 || nt.length === 0) return 0;
  let hit = 0;
  for (const v of vt) {
    let best = 0;
    for (const n of nt) {
      if (n === v) { best = 1; break; }
      if (v.length >= 4 && (n.startsWith(v) || v.startsWith(n)) && Math.min(n.length, v.length) >= 4) best = Math.max(best, 0.9);
      else best = Math.max(best, levenshteinRatio(v, n) >= 0.8 ? 0.8 : 0);
    }
    hit += best;
  }
  return hit / vt.length;
}

function referenceHit(invoiceNumber: string | undefined, narration: string): boolean {
  if (!invoiceNumber) return false;
  const k = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (k.length < 3) return false;
  return narration.toLowerCase().replace(/[^a-z0-9]/g, "").includes(k);
}

export interface EngineOptions {
  amountTolerancePct: number; // exact tier (auto-approvable), e.g. 0.0002 = 0.02%
  nearTolerancePct: number; // near tier (review only), e.g. 0.005 = 0.5%
  amountToleranceAbs: number; // rupees, whichever is larger
  tdsRates: number[]; // net-of-TDS payment tiers
  daysBefore: number; // payment before invoice date
  daysAfter: number; // payment after invoice date
}
export const DEFAULT_ENGINE: EngineOptions = { amountTolerancePct: 0.0002, nearTolerancePct: 0.005, amountToleranceAbs: 1, tdsRates: [0.01, 0.02, 0.05, 0.1], daysBefore: 7, daysAfter: 45 };

type Tier = "EXACT" | "NEAR" | "NET_OF_TDS";
interface Candidate { inv: number; bank: number; score: number; tier: Tier; vendor: number; ref: boolean; days: number }

function amountTier(inv: number, bank: number, o: EngineOptions): Tier | null {
  const tol = Math.max(o.amountToleranceAbs, inv * o.amountTolerancePct);
  if (Math.abs(inv - bank) <= tol) return "EXACT";
  if (Math.abs(inv - bank) <= Math.max(o.amountToleranceAbs, inv * o.nearTolerancePct)) return "NEAR";
  for (const r of o.tdsRates) if (Math.abs(inv * (1 - r) - bank) <= Math.max(o.amountToleranceAbs, inv * 0.003)) return "NET_OF_TDS";
  return null;
}

export function reconcileBatch(invoices: Invoice[], bankRows: BankRow[], thresholds: ReconcileThresholds = DEFAULT_THRESHOLDS, opts: EngineOptions = DEFAULT_ENGINE): MatchResult[] {
  const cands: Candidate[] = [];
  const perInv: Candidate[][] = invoices.map(() => []);
  const perBank = new Map<number, Candidate[]>();

  // Index bank debits by amount so each invoice only inspects rows that can pass
  // the amount gate (keeps 5k x 5k batches fast); dates parsed once, not per pair.
  const bankMs = bankRows.map((b) => (b.transactionDate ? Date.parse(b.transactionDate + "T00:00:00Z") : NaN));
  const order = bankRows.map((_, j) => j).filter((j) => bankRows[j]!.debitAmount > 0 && !Number.isNaN(bankMs[j]!)).sort((a, b) => bankRows[a]!.debitAmount - bankRows[b]!.debitAmount);
  const lowerBound = (v: number) => { let lo = 0, hi = order.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (bankRows[order[mid]!]!.debitAmount < v) lo = mid + 1; else hi = mid; } return lo; };
  const maxTds = Math.max(0, ...opts.tdsRates);

  invoices.forEach((inv, i) => {
    if (!inv.documentDate || !(inv.rawTotalAmount > 0)) return;
    const invMs = Date.parse(inv.documentDate + "T00:00:00Z");
    if (Number.isNaN(invMs)) return;
    const loAmt = inv.rawTotalAmount * (1 - maxTds - 0.005) - 1;
    const hiAmt = inv.rawTotalAmount * 1.005 + 1;
    for (let k = lowerBound(loAmt); k < order.length; k++) {
      const j = order[k]!;
      const b = bankRows[j]!;
      if (b.debitAmount > hiAmt) break;
      const signed = (bankMs[j]! - invMs) / 86_400_000;
      if (signed < -opts.daysBefore || signed > opts.daysAfter) continue;
      const tier = amountTier(inv.rawTotalAmount, b.debitAmount, opts);
      if (!tier) continue; // HARD amount gate — wrong amount can never match
      const vendor = vendorSimilarity(inv.vendorName, b.narration);
      const ref = referenceHit(inv.invoiceNumber, b.narration);
      const dateScore = Math.exp(-0.03 * Math.abs(signed));
      let score = 0.3 + 0.4 * vendor + 0.15 * dateScore + (ref ? 0.15 : 0);
      if (tier !== "EXACT") score -= 0.1;
      const c: Candidate = { inv: i, bank: j, score: roundTo6(Math.min(score, 1)), tier, vendor, ref, days: Math.abs(signed) };
      cands.push(c);
      perInv[i]!.push(c);
      (perBank.get(j) ?? perBank.set(j, []).get(j)!).push(c);
    }
  });

  // One-to-one: strongest pairs claim their bank row first.
  cands.sort((a, b) => b.score - a.score || a.days - b.days);
  const usedBank = new Set<number>();
  const assigned = new Map<number, Candidate>();
  for (const c of cands) {
    if (assigned.has(c.inv) || usedBank.has(c.bank)) continue;
    assigned.set(c.inv, c);
    usedBank.add(c.bank);
  }

  return invoices.map((inv, i): MatchResult => {
    if (!inv.documentDate || !(inv.rawTotalAmount > 0)) {
      return { documentId: inv.documentId, matchedBankTransactionId: null, score: 0, status: "FAILED", reason: "Missing amount or date for matching" };
    }
    const c = assigned.get(i);
    if (!c) {
      return { documentId: inv.documentId, matchedBankTransactionId: null, score: 0, status: "UNMATCHED", reason: "No bank debit with a matching amount inside the payment window (or it was claimed by a stronger match)" };
    }
    const bank = bankRows[c.bank]!;
    const pct = `${(c.score * 100).toFixed(0)}%`;
    // Ambiguity: another bank row fits this invoice about as well, or another invoice competes for this bank row.
    // An invoice-number hit in the narration is decisive and clears it.
    const rivals = c.ref ? 0 : perInv[i]!.filter((x) => x !== c && c.score - x.score < 0.03).length + (perBank.get(c.bank) ?? []).filter((x) => x !== c && !x.ref && c.score - x.score < 0.03).length;
    const identity = c.ref || c.vendor >= 0.6;
    if (c.tier === "EXACT" && identity && c.score >= thresholds.autoApproveThreshold - 0.15 && rivals === 0) {
      return { documentId: inv.documentId, matchedBankTransactionId: bank.transactionId, score: c.score, status: "RECONCILED", reason: `Matched "${bank.narration}" (${pct}): exact amount${c.ref ? ", invoice number in narration" : ""}, vendor similarity ${(c.vendor * 100).toFixed(0)}%, ${c.days} day(s) apart` };
    }
    const why = c.tier === "NET_OF_TDS" ? "amount equals invoice net of a standard TDS rate" : c.tier === "NEAR" ? "amount differs slightly (bank charges / rounding?)" : rivals > 0 ? "more than one equally good candidate" : !identity ? "amount matches but vendor/reference does not" : "confidence below auto-approve";
    return { documentId: inv.documentId, matchedBankTransactionId: null, score: c.score, status: "MANUAL_REVIEW", reason: `Best candidate "${bank.narration}" scored ${pct} — needs a human check: ${why}` };
  });
}
