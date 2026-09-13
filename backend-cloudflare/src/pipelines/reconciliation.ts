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

export function reconcileBatch(invoices: Invoice[], bankRows: BankRow[], thresholds: ReconcileThresholds = DEFAULT_THRESHOLDS): MatchResult[] {
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
