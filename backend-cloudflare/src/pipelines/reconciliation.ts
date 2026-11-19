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
  /** For MANUAL_REVIEW: the bank row the engine thinks is the payment (not applied until a human confirms). */
  candidateBankTransactionId?: string | null;
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

// Generic trade words ("Traders", "Steel Works", "Logistics") are weak evidence of identity: banks routinely
// drop or shorten them, so they count 0.4 where a distinctive word counts 1.
const GENERIC = new Set(["traders", "trading", "enterprises", "enterprise", "works", "industries", "industry", "solutions", "services", "service", "supplies", "supply", "logistics", "packaging", "agencies", "agency", "associates", "sons", "brothers", "bros", "group", "international", "exports", "export", "imports", "import", "foods", "food", "textiles", "chemicals", "electricals", "electronics", "engineering", "technologies", "technology", "systems", "distributors", "marketing", "corporation", "stores", "store", "office", "print", "printers", "packers", "movers", "transport", "transporters", "infra", "infrastructure", "builders", "constructions", "construction", "pharma", "laboratories", "labs", "agro", "products", "product", "ventures", "impex", "exim", "india", "global", "overseas", "mart", "retail", "wholesale", "steel", "tools", "motors", "auto", "paper", "plastics"]);

// Share of the vendor's (weighted) tokens that appear in the bank narration — exactly, with a small typo /
// truncation, or run together as UPI/IMPS payees often are ("VIKRAMTEXTILES"). Containment, not whole-string distance.
export interface VendorPre { vt: string[]; vendorCompact: string }
export interface NarrationPre { nt: string[]; compact: string }
export const preVendor = (vendor: string): VendorPre => { const vt = tokens(vendor); return { vt, vendorCompact: vt.join("") }; };
export const preNarration = (narration: string): NarrationPre => ({ nt: tokens(narration), compact: narration.toLowerCase().replace(/[^a-z0-9]+/g, "") });

/** vendorSimilarity on strings that were tokenised once. The engine compares every candidate pair, so tokenising per pair (two regex passes + a split each) was most of its time. */
export function vendorSimilarityPre(v: VendorPre, n: NarrationPre): number {
  const { vt, vendorCompact } = v, { nt, compact } = n;
  if (vt.length === 0 || nt.length === 0) return 0;
  if (vendorCompact.length >= 6 && compact.includes(vendorCompact)) return 1;
  let hit = 0, total = 0;
  for (const t of vt) {
    const w = GENERIC.has(t) ? 0.4 : 1;
    total += w;
    let best = 0;
    for (const x of nt) {
      if (x === t) { best = 1; break; }
      if (t.length >= 4 && (x.startsWith(t) || t.startsWith(x)) && Math.min(x.length, t.length) >= 4) best = Math.max(best, 0.9);
      else best = Math.max(best, levenshteinRatio(t, x) >= 0.8 ? 0.8 : 0);
    }
    if (best === 0 && t.length >= 4 && compact.includes(t)) best = 0.9;
    hit += best * w;
  }
  return hit / total;
}

export function vendorSimilarity(vendor: string, narration: string): number {
  return vendorSimilarityPre(preVendor(vendor), preNarration(narration));
}

/** Normalised invoice number for narration matching ("" = too short to be evidence). */
const refKey = (invoiceNumber: string | undefined): string => { if (!invoiceNumber) return ""; const k = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, ""); return k.length < 3 ? "" : k; };

function referenceHit(invoiceNumber: string | undefined, narration: string): boolean {
  if (!invoiceNumber) return false;
  const k = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (k.length < 3) return false;
  return narration.toLowerCase().replace(/[^a-z0-9]/g, "").includes(k);
}

export interface EngineOptions {
  amountTolerancePct: number; // extra % allowance on top of the absolute one for the exact tier (default 0: a ₹7 difference on ₹80,000 is NOT an exact match — measured wrong auto-match at scale)
  nearTolerancePct: number; // near tier (review only), e.g. 0.005 = 0.5%
  amountToleranceAbs: number; // rupees, whichever is larger
  tdsRates: number[]; // net-of-TDS payment tiers
  daysBefore: number; // payment before invoice date
  daysAfter: number; // payment after invoice date
}
export const DEFAULT_ENGINE: EngineOptions = { amountTolerancePct: 0, nearTolerancePct: 0.005, amountToleranceAbs: 1, tdsRates: [0.01, 0.02, 0.05, 0.1], daysBefore: 7, daysAfter: 45 };

type Tier = "EXACT" | "NEAR" | "NET_OF_TDS";
interface Candidate { inv: number; bank: number; score: number; tier: Tier; vendor: number; ref: boolean; days: number }

function amountTier(inv: number, bank: number, o: EngineOptions): Tier | null {
  const tol = Math.max(o.amountToleranceAbs, inv * o.amountTolerancePct);
  if (Math.abs(inv - bank) <= tol) return "EXACT";
  if (Math.abs(inv - bank) <= Math.max(o.amountToleranceAbs, inv * o.nearTolerancePct)) return "NEAR";
  for (const r of o.tdsRates) if (Math.abs(inv * (1 - r) - bank) <= Math.max(o.amountToleranceAbs, inv * 0.003)) return "NET_OF_TDS";
  return null;
}

export function reconcileBatch(invoices: Invoice[], bankRows: BankRow[], thresholds: ReconcileThresholds = DEFAULT_THRESHOLDS, opts: EngineOptions = DEFAULT_ENGINE, stats?: { candidates: number }): MatchResult[] {
  const cands: Candidate[] = [];
  const perInv: Candidate[][] = invoices.map(() => []);
  const perBank = new Map<number, Candidate[]>();

  // Index bank debits by amount so each invoice only inspects rows that can pass
  // the amount gate (keeps 5k x 5k batches fast); dates parsed once, not per pair.
  const bankMs = bankRows.map((b) => (b.transactionDate ? Date.parse(b.transactionDate + "T00:00:00Z") : NaN));
  const order = bankRows.map((_, j) => j).filter((j) => bankRows[j]!.debitAmount > 0 && !Number.isNaN(bankMs[j]!)).sort((a, b) => bankRows[a]!.debitAmount - bankRows[b]!.debitAmount);
  const lowerBound = (v: number) => { let lo = 0, hi = order.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (bankRows[order[mid]!]!.debitAmount < v) lo = mid + 1; else hi = mid; } return lo; };
  const maxTds = Math.max(0, ...opts.tdsRates);
  // Tokenise each vendor / narration once, lazily (only rows that reach a candidate pair), instead of once per pair.
  const vpre: (VendorPre | undefined)[] = new Array(invoices.length), npre: (NarrationPre | undefined)[] = new Array(bankRows.length);
  const refK = invoices.map((x) => refKey(x.invoiceNumber));

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
      const vp = (vpre[i] ??= preVendor(inv.vendorName)), np = (npre[j] ??= preNarration(b.narration));
      const vendor = vendorSimilarityPre(vp, np);
      const ref = refK[i] !== "" && np.compact.includes(refK[i]!);
      const dateScore = Math.exp(-0.03 * Math.abs(signed));
      // Prefer the candidate whose amount is closest: two same-vendor payments a few rupees apart must not be decided by which one is nearer in date.
      const exactness = 1 - Math.min(1, Math.abs(inv.rawTotalAmount - b.debitAmount) / Math.max(opts.amountToleranceAbs, 1e-9));
      let score = 0.3 + 0.4 * vendor + 0.15 * dateScore + 0.05 * exactness + (ref ? 0.15 : 0);
      if (tier !== "EXACT") score -= 0.1;
      const c: Candidate = { inv: i, bank: j, score: roundTo6(Math.min(score, 1)), tier, vendor, ref, days: Math.abs(signed) };
      cands.push(c);
      perInv[i]!.push(c);
      (perBank.get(j) ?? perBank.set(j, []).get(j)!).push(c);
    }
  });

  if (stats) stats.candidates = cands.length;

  // One-to-one: strongest pairs claim their bank row first.
  cands.sort((a, b) => b.score - a.score || a.days - b.days);
  const usedBank = new Set<number>();
  const assigned = new Map<number, Candidate>();
  for (const c of cands) {
    if (assigned.has(c.inv) || usedBank.has(c.bank)) continue;
    assigned.set(c.inv, c);
    usedBank.add(c.bank);
  }

  // Decisive evidence: bank rows / invoices tied together by an invoice number written in the narration.
  const refBanks = new Set<number>(); const refInvs = new Set<number>();
  for (const x of cands) if (x.ref) { refBanks.add(x.bank); refInvs.add(x.inv); }

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
    // A competitor is anything of the SAME amount tier whose payee/vendor evidence is about as strong — date proximity is
    // deliberately NOT a tie-breaker: for identical invoices (rent, retainers, repeat orders) the payment that happens to be
    // nearer in time is the wrong one often enough (≈5% measured) that guessing is not acceptable for an auto-approval.
    // A competitor is cleared only by decisive evidence: its bank row is named by ANOTHER invoice's number, or its invoice
    // already has an invoice-number hit.
    const band = (x: Candidate) => x.tier === c.tier && Math.abs(x.vendor - c.vendor) < 0.2;
    const rivals = c.ref ? 0
      : perInv[i]!.filter((x) => x !== c && band(x) && !refBanks.has(x.bank)).length
      + (perBank.get(c.bank) ?? []).filter((x) => x !== c && !x.ref && band(x) && !refInvs.has(x.inv)).length;
    const identity = c.ref || c.vendor >= 0.6;
    if (c.tier === "EXACT" && identity && c.score >= thresholds.autoApproveThreshold - 0.25 && rivals === 0) {
      return { documentId: inv.documentId, matchedBankTransactionId: bank.transactionId, score: c.score, status: "RECONCILED", reason: `Matched "${bank.narration}" (${pct}): exact amount${c.ref ? ", invoice number in narration" : ""}, vendor similarity ${(c.vendor * 100).toFixed(0)}%, ${c.days} day(s) apart` };
    }
    const why = c.tier === "NET_OF_TDS" ? "amount equals invoice net of a standard TDS rate" : c.tier === "NEAR" ? "amount differs slightly (bank charges / rounding?)" : rivals > 0 ? "more than one equally good candidate" : !identity ? "amount matches but vendor/reference does not" : "confidence below auto-approve";
    return { documentId: inv.documentId, matchedBankTransactionId: null, candidateBankTransactionId: bank.transactionId, score: c.score, status: "MANUAL_REVIEW", reason: `Best candidate "${bank.narration}" scored ${pct} — needs a human check: ${why}` };
  });
}

// ───────────────────────── scale guard ─────────────────────────
// The engine builds one Candidate object for every (invoice, bank row) pair that passes the amount and date gates. That is tiny for
// ordinary data, but it grows with the SQUARE of how many invoices share an amount (rent, retainers, round-number bills): measured on
// a laptop, 5,000 identical-amount invoices produced ~12 M candidates, 44 s and ~470 MB — far past a Worker's 128 MB. The functions
// below keep every run inside a fixed budget, and change nothing at all for data that is under it.

interface BankIndex { bankMs: number[]; order: number[]; lowerBound: (v: number) => number }
function buildBankIndex(bankRows: BankRow[]): BankIndex {
  const bankMs = bankRows.map((b) => (b.transactionDate ? Date.parse(b.transactionDate + "T00:00:00Z") : NaN));
  const order = bankRows.map((_, j) => j).filter((j) => bankRows[j]!.debitAmount > 0 && !Number.isNaN(bankMs[j]!)).sort((a, b) => bankRows[a]!.debitAmount - bankRows[b]!.debitAmount);
  const lowerBound = (v: number) => { let lo = 0, hi = order.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (bankRows[order[mid]!]!.debitAmount < v) lo = mid + 1; else hi = mid; } return lo; };
  return { bankMs, order, lowerBound };
}

/** Candidate pairs one invoice has (same gates as reconcileBatch), counted without allocating them; stops once past `limit`. */
function pairsForInvoice(inv: Invoice, bankRows: BankRow[], ix: BankIndex, limit: number, opts: EngineOptions, maxTds: number): number {
  if (!inv.documentDate || !(inv.rawTotalAmount > 0)) return 0;
  const invMs = Date.parse(inv.documentDate + "T00:00:00Z");
  if (Number.isNaN(invMs)) return 0;
  const loAmt = inv.rawTotalAmount * (1 - maxTds - 0.005) - 1;
  const hiAmt = inv.rawTotalAmount * 1.005 + 1;
  let n = 0;
  for (let k = ix.lowerBound(loAmt); k < ix.order.length; k++) {
    const j = ix.order[k]!, b = bankRows[j]!;
    if (b.debitAmount > hiAmt) break;
    const signed = (ix.bankMs[j]! - invMs) / 86_400_000;
    if (signed < -opts.daysBefore || signed > opts.daysAfter) continue;
    if (!amountTier(inv.rawTotalAmount, b.debitAmount, opts)) continue;
    if (++n > limit) return n;
  }
  return n;
}

/** Number of candidate pairs reconcileBatch would build, counted without allocating them, stopping once past `limit`. */
export function countCandidatePairs(invoices: Invoice[], bankRows: BankRow[], limit = Infinity, opts: EngineOptions = DEFAULT_ENGINE): number {
  const ix = buildBankIndex(bankRows), maxTds = Math.max(0, ...opts.tdsRates);
  let n = 0;
  for (const inv of invoices) { n += pairsForInvoice(inv, bankRows, ix, limit - n, opts, maxTds); if (n > limit) return n; }
  return n;
}

const UNMATCHED_REASON = "No bank debit with a matching amount inside the payment window (or it was claimed by a stronger match)";
// Memory: one candidate is ~90 bytes once the per-invoice / per-bank indexes are counted, and a Worker has 128 MB for everything, so one pass
// holds at most 400 k of them (measured: 1.5 M exhausts a 128 MB heap, 500 k fits). CPU: the engine costs roughly 0.6 µs per pair, so 20 M pairs
// in total is ~12 s of a Worker's 30 s; invoices beyond that are reported as FAILED with a reason instead of being attempted.
export const DEFAULT_MAX_PAIRS = 400_000;
export const DEFAULT_MAX_TOTAL_PAIRS = 20_000_000;
const TOO_DENSE_REASON = "Too many look-alike invoices (same amount, same period) to match in one run — match these manually, or upload the invoices and bank statement in smaller date ranges";
const SLICE_RIVAL_WORK_CAP = 1_000_000; // outsider comparisons allowed per run when checking for cross-slice rivals; beyond it, play safe

/**
 * reconcileBatch with a bounded working set.
 *
 * Within `maxPairs` candidate pairs this IS reconcileBatch — identical output. Above that, invoices are cut into date-ordered slices
 * that each stay inside the budget, every slice is matched against ALL the bank rows, and the slices are then reconciled with each
 * other under one rule: **a slice may only auto-approve what a whole-run pass would also have auto-approved.** An auto-match is kept
 * when its narration carries the invoice number (decisive evidence), or when no invoice from another slice is an equally good
 * claimant for that bank row (same amount tier, vendor evidence within the engine's rival band). Anything contested becomes a
 * MANUAL_REVIEW suggestion instead — never a silent guess. One bank row is auto-matched to at most one invoice; review suggestions
 * that point at a row someone else now owns are re-run against the free rows. The result is never more eager than the single pass,
 * and for data without cross-slice competition it is the same.
 */
export function reconcileBatchBudgeted(invoices: Invoice[], bankRows: BankRow[], opts: { maxPairs?: number; maxTotalPairs?: number; onSliced?: (slices: number) => void; onCapped?: (skipped: number) => void } = {}): MatchResult[] {
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS, maxTotalPairs = opts.maxTotalPairs ?? DEFAULT_MAX_TOTAL_PAIRS;
  if (countCandidatePairs(invoices, bankRows, maxPairs) <= maxPairs) return reconcileBatch(invoices, bankRows);

  const ix = buildBankIndex(bankRows), maxTds = Math.max(0, ...DEFAULT_ENGINE.tdsRates);
  const idx = invoices.map((_, i) => i).sort((a, b) => (invoices[a]!.documentDate || "￿").localeCompare(invoices[b]!.documentDate || "￿") || a - b);
  const slices: number[][] = [];
  const skipped: number[] = [];
  let cur: number[] = [], pairs = 0, total = 0;
  for (const i of idx) {
    const c = pairsForInvoice(invoices[i]!, bankRows, ix, maxPairs, DEFAULT_ENGINE, maxTds); // against the FULL bank list: a safe upper bound for the slice
    if (skipped.length > 0 || total + c > maxTotalPairs) { skipped.push(i); continue; } // total CPU is bounded too: past the cap the rest is reported, not attempted
    total += c;
    if (cur.length > 0 && pairs + c > maxPairs) { slices.push(cur); cur = []; pairs = 0; }
    cur.push(i); pairs += c;
  }
  if (cur.length) slices.push(cur);
  opts.onSliced?.(slices.length);
  if (skipped.length) opts.onCapped?.(skipped.length);

  const out: MatchResult[] = new Array(invoices.length);
  for (const i of skipped) out[i] = { documentId: invoices[i]!.documentId, matchedBankTransactionId: null, score: 0, status: "FAILED", reason: TOO_DENSE_REASON };
  const sliceOf: number[] = new Array(invoices.length).fill(-1);
  slices.forEach((slice, s) => {
    const res = reconcileBatch(slice.map((i) => invoices[i]!), bankRows);
    res.forEach((r, k) => { out[slice[k]!] = r; sliceOf[slice[k]!] = s; });
  });
  return settleSlices(invoices, bankRows, out, sliceOf, maxPairs, maxTotalPairs);
}

function settleSlices(invoices: Invoice[], bankRows: BankRow[], out: MatchResult[], sliceOf: number[], maxPairs: number, maxTotalPairs: number): MatchResult[] {
  const E = DEFAULT_ENGINE;
  const rowOf = new Map(bankRows.map((b, j) => [b.transactionId, j]));
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const toReview = (i: number, why: string): MatchResult => {
    const r = out[i]!, b = bankRows[rowOf.get(r.matchedBankTransactionId ?? r.candidateBankTransactionId!)!]!;
    return { documentId: r.documentId, matchedBankTransactionId: null, candidateBankTransactionId: b.transactionId, score: r.score, status: "MANUAL_REVIEW", reason: `Best candidate "${b.narration}" scored ${pct(r.score)} — needs a human check: ${why}` };
  };
  const toUnmatched = (i: number): MatchResult => ({ documentId: out[i]!.documentId, matchedBankTransactionId: null, score: 0, status: "UNMATCHED", reason: UNMATCHED_REASON });

  // Invoices that could be an equally good claimant for a bank row, found by amount.
  const valid = invoices.map((_, i) => i).filter((i) => invoices[i]!.documentDate && invoices[i]!.rawTotalAmount > 0 && !Number.isNaN(Date.parse(invoices[i]!.documentDate + "T00:00:00Z"))).sort((a, b) => invoices[a]!.rawTotalAmount - invoices[b]!.rawTotalAmount);
  const amounts = valid.map((i) => invoices[i]!.rawTotalAmount);
  const lowerBoundAmt = (v: number) => { let lo = 0, hi = amounts.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (amounts[mid]! < v) lo = mid + 1; else hi = mid; } return lo; };
  let work = 0;
  const hasOutsideRival = (i: number): boolean => {
    const inv = invoices[i]!, b = bankRows[rowOf.get(out[i]!.matchedBankTransactionId!)!]!;
    const bMs = Date.parse(b.transactionDate + "T00:00:00Z"), mine = vendorSimilarity(inv.vendorName, b.narration);
    const lo = (b.debitAmount - E.amountToleranceAbs) / (1 + E.amountTolerancePct) - 1e-9, hi = (b.debitAmount + E.amountToleranceAbs) / Math.max(1e-9, 1 - E.amountTolerancePct) + 1e-9;
    for (let p = lowerBoundAmt(lo); p < valid.length && amounts[p]! <= hi; p++) {
      const k = valid[p]!;
      if (sliceOf[k] === sliceOf[i]) continue;
      if (++work > SLICE_RIVAL_WORK_CAP) return true; // out of budget: treat as contested (a review, never a wrong auto-match)
      const other = invoices[k]!;
      const signed = (bMs - Date.parse(other.documentDate + "T00:00:00Z")) / 86_400_000;
      if (signed < -E.daysBefore || signed > E.daysAfter) continue;
      if (amountTier(other.rawTotalAmount, b.debitAmount, E) !== "EXACT") continue;
      if (Math.abs(vendorSimilarity(other.vendorName, b.narration) - mine) < 0.2) return true;
    }
    return false;
  };

  // 1. Keep an auto-match only if it is decisive or uncontested.
  const kept: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.status !== "RECONCILED") continue;
    const b = bankRows[rowOf.get(out[i]!.matchedBankTransactionId!)!]!;
    if (referenceHit(invoices[i]!.invoiceNumber, b.narration) || !hasOutsideRival(i)) kept.push(i);
    else out[i] = toReview(i, "more than one equally good candidate");
  }
  // 2. A bank row is auto-matched to one invoice only: the strongest claim wins.
  const owner = new Map<string, number>();
  const losers: number[] = [];
  for (const i of kept.sort((a, b) => out[b]!.score - out[a]!.score || a - b)) {
    const row = out[i]!.matchedBankTransactionId!;
    if (owner.has(row)) losers.push(i); else owner.set(row, i);
  }
  // 3. Re-run what lost its row, and what only suggested a row somebody else now owns, against the rows still free.
  const stale = [...losers];
  for (let i = 0; i < out.length; i++) { const r = out[i]!; if (r.status === "MANUAL_REVIEW" && r.candidateBankTransactionId && owner.has(r.candidateBankTransactionId)) stale.push(i); }
  if (stale.length) {
    const free = bankRows.filter((b) => !owner.has(b.transactionId));
    const again = reconcileBatchBudgeted(stale.map((i) => invoices[i]!), free, { maxPairs, maxTotalPairs }); // strictly fewer invoices than this run (the owners are not in it), so it terminates
    again.forEach((r, k) => {
      const i = stale[k]!;
      out[i] = r;
      if (r.status !== "RECONCILED") return;
      const b = bankRows[rowOf.get(r.matchedBankTransactionId!)!]!;
      if (referenceHit(invoices[i]!.invoiceNumber, b.narration) && !owner.has(b.transactionId)) owner.set(b.transactionId, i);
      else out[i] = toReview(i, "more than one equally good candidate"); // repair pass stays conservative: only invoice-number evidence auto-approves
    });
  }
  // 4. Last check: nobody suggests a row that someone else owns.
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!;
    if (r.status === "MANUAL_REVIEW" && r.candidateBankTransactionId && owner.has(r.candidateBankTransactionId) && owner.get(r.candidateBankTransactionId) !== i) out[i] = toUnmatched(i);
  }
  return out;
}
