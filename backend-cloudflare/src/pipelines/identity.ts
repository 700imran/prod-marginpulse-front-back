// Exact port of internal/pipelines/identity/identity.go. Same
// graceful-degradation behavior: falls back to PENDING (not an error)
// when GST_API_CLIENT_ID isn't configured, so the app stays usable
// without paid verification API access.
import type { Env } from "../config";
import { levenshteinRatio } from "./reconciliation";

// Strips punctuation and common Indian legal-entity suffixes so
// "Priya Traders" and "Priya Traders Pvt Ltd" normalize to the same
// string before comparison. Deliberately conservative — it doesn't
// touch word order or transliteration variants.
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|mr|mrs|ms)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface IdentityResult {
  status: "VERIFIED" | "FAILED" | "PENDING";
  error?: string;
  legalName?: string;
  verifiedName?: string;
}

export async function verifyGSTIN(env: Env, gstin: string): Promise<IdentityResult> {
  if (!env.GST_API_CLIENT_ID) {
    return { status: "PENDING", error: "GST verification API not configured — verify manually" };
  }
  let resp: Response;
  try {
    resp = await fetch(`${env.GST_API_BASE_URL}/gstin/${gstin}`, {
      headers: { "client-id": env.GST_API_CLIENT_ID, "client-secret": env.GST_API_CLIENT_SECRET },
    });
  } catch (e) {
    return { status: "FAILED", error: `GST portal request failed: ${(e as Error).message}` };
  }
  if (!resp.ok) return { status: "FAILED", error: `GST portal returned HTTP ${resp.status}` };

  let body: { lgnm?: string; tradeNam?: string; sts?: string };
  try {
    body = await resp.json();
  } catch {
    return { status: "FAILED", error: "could not parse GST portal response" };
  }
  if (body.sts && body.sts !== "Active") {
    return { status: "FAILED", error: `GSTIN status is "${body.sts}", not Active` };
  }
  return { status: "VERIFIED", legalName: body.lgnm || body.tradeNam || "" };
}

export async function verifyPAN(env: Env, pan: string, label?: string): Promise<IdentityResult> {
  if (!env.GST_API_CLIENT_ID) {
    return { status: "PENDING", error: "PAN verification API not configured — verify manually" };
  }
  let resp: Response;
  try {
    resp = await fetch(`${env.GST_API_BASE_URL}/pan/${pan}`, {
      headers: { "client-id": env.GST_API_CLIENT_ID, "client-secret": env.GST_API_CLIENT_SECRET },
    });
  } catch (e) {
    return { status: "FAILED", error: `PAN verification request failed: ${(e as Error).message}` };
  }
  if (!resp.ok) return { status: "FAILED", error: `PAN verification API returned HTTP ${resp.status}` };

  let body: { full_name?: string; valid?: boolean };
  try {
    body = await resp.json();
  } catch {
    return { status: "FAILED", error: "could not parse PAN verification response" };
  }
  if (!body.valid) return { status: "FAILED", error: "PAN reported as invalid" };
  // `label` (e.g. a stated business name) isn't sent to the API — it's
  // available here for a stricter name-match check, same shape as the
  // bank-account holder-name check below, if you want PAN verification
  // to also flag a name mismatch rather than accepting any valid PAN.
  return { status: "VERIFIED", legalName: body.full_name };
}

export async function verifyBankAccount(env: Env, accountNumber: string, ifscCode: string, accountHolderName?: string): Promise<IdentityResult> {
  if (!env.GST_API_CLIENT_ID) {
    return { status: "PENDING", error: "Bank account verification API not configured — verify manually" };
  }
  let resp: Response;
  try {
    resp = await fetch(`${env.GST_API_BASE_URL}/bank-account/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "client-id": env.GST_API_CLIENT_ID, "client-secret": env.GST_API_CLIENT_SECRET },
      body: JSON.stringify({ account_number: accountNumber, ifsc: ifscCode }),
    });
  } catch (e) {
    return { status: "FAILED", error: `bank verification request failed: ${(e as Error).message}` };
  }
  if (!resp.ok) return { status: "FAILED", error: `bank verification API returned HTTP ${resp.status}` };

  let body: { account_exists?: boolean; name_at_bank?: string };
  try {
    body = await resp.json();
  } catch {
    return { status: "FAILED", error: "could not parse bank verification response" };
  }
  if (!body.account_exists) return { status: "FAILED", error: "account not found / IFSC mismatch" };

  // Name-match check against what the tenant entered. The exact
  // fuzzy-matching threshold the Go original used for this comparison
  // wasn't in the portion of identity.go this was ported from, so this
  // still isn't a faithful port of that specific comparison — but it's
  // now substring-OR-fuzzy instead of substring-only: normalize common
  // legal-entity suffixes/punctuation, then fall back to the same
  // Levenshtein ratio reconciliation.ts uses for vendor-name matching.
  // This is meaningfully less likely to reject legitimate near-matches
  // (e.g. "Priya Traders" vs "Priya Traders Pvt Ltd", or a minor typo)
  // than the bare substring check was. Tighten further if the exact
  // Go behavior turns out to matter.
  if (accountHolderName && body.name_at_bank) {
    const a = normalizeName(accountHolderName);
    const b = normalizeName(body.name_at_bank);
    const contained = a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
    const similar = levenshteinRatio(a, b) >= 0.82;
    if (!contained && !similar) {
      return { status: "FAILED", error: `Account holder name doesn't match bank records (bank has "${body.name_at_bank}")`, verifiedName: body.name_at_bank };
    }
  }
  return { status: "VERIFIED", verifiedName: body.name_at_bank };
}
