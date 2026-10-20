// Port of two things that both feed the dashboard:
//  1. reconciliation_handlers.go's HandleDashboardSummary (counts +
//     plain-English insight) -> buildDashboardSummary
//  2. pipelines/dashboard/insights.go's Build (the "what to do today"
//     ITC-risk / vendor follow-up / filing-deadline view) -> buildBusinessInsights
import type { Sql } from "../db";
import type { Env } from "../config";
import type { TenantContext } from "../auth/supabase";
import { countDocumentsByTenant, countDocumentsByStatus, listByGSTStatus, type DocumentRow } from "../repository/documents";
import { listAnomalies } from "../repository/anomalies";
import { generateInsight } from "./insights";
import { upstash } from "../ratelimit";

export interface DashboardSummary {
  summaryMetrics: {
    totalUploadedDocuments: number;
    successfullyReconciledCount: number;
    unreconciledAnomaliesDetected: number;
    gstMismatchFlagCount: number;
  };
  itcAtRisk: number;
  gstProblemVendors: string[];
  plainEnglishInsight: string;
}

// includeInsight=false skips the paid LLM-written paragraph entirely (no
// credit reservation, no Anthropic call) and returns plainEnglishInsight as
// "". The assistant uses this: it narrates the numbers itself as part of its
// own already-metered reply, so charging AI_INSIGHT on top would double-bill
// one user action.
export async function buildDashboardSummary(sql: Sql, env: Env, tenant: TenantContext, opts: { includeInsight?: boolean } = {}): Promise<DashboardSummary> {
  const tenantId = tenant.tenantId;
  // The five reads are independent. They share one physical connection (db.ts,
  // max:1 — required for RLS), so postgres.js pipelines them: one network wait
  // instead of five back-to-back round trips, with no change to tenant scoping.
  //
  // Mirrors the Go handler's own comment: openAnomalies is intentionally a
  // capped list(20) used as both the anomaly source AND the displayed count,
  // matching the original Python behavior it was ported from.
  const [total, reconciled, openAnomalies, notFiledDocs, mismatchDocs] = await Promise.all([
    countDocumentsByTenant(sql, tenantId),
    countDocumentsByStatus(sql, tenantId, "RECONCILED"),
    listAnomalies(sql, tenantId, "OPEN", 20, 0),
    listByGSTStatus(sql, tenantId, "NOT_FILED").catch(() => [] as DocumentRow[]),
    listByGSTStatus(sql, tenantId, "MISMATCH").catch(() => [] as DocumentRow[]),
  ]);
  const gstMismatchCount = openAnomalies.filter((a) => a.anomalyType === "TAX_PORTAL_MISMATCH").length;

  let itcAtRisk = 0;
  const vendorSet = new Set<string>();
  const problemVendors: string[] = [];
  for (const d of [...notFiledDocs, ...mismatchDocs]) {
    itcAtRisk += parseFloat(d.taxAmount ?? "0");
    if (d.vendorName && !vendorSet.has(d.vendorName)) {
      vendorSet.add(d.vendorName);
      if (problemVendors.length < 5) problemVendors.push(d.vendorName);
    }
  }

  const insightInput = {
    totalUploadedDocuments: total,
    successfullyReconciledCount: reconciled,
    unreconciledAnomaliesDetected: openAnomalies.length,
    gstMismatchFlagCount: gstMismatchCount,
    itcAtRisk,
    gstProblemVendors: problemVendors,
    anomalyBreakdown: {},
    period: "",
  };
  const plainEnglish = opts.includeInsight === false ? "" : await cachedInsight(sql, env, insightInput, tenant);

  return {
    summaryMetrics: {
      totalUploadedDocuments: total,
      successfullyReconciledCount: reconciled,
      unreconciledAnomaliesDetected: openAnomalies.length,
      gstMismatchFlagCount: gstMismatchCount,
    },
    itcAtRisk,
    gstProblemVendors: problemVendors,
    plainEnglishInsight: plainEnglish,
  };
}


// --- Insight cache ----------------------------------------------------------
// The AI paragraph used to be regenerated — a live Anthropic call AND a spent
// credit — on every dashboard visit, even when nothing had changed. It is a
// pure function of the numbers, so cache it per tenant per distinct set of
// numbers: same data → same paragraph, no call, no credit. New data (or a
// 6-hour expiry) regenerates it. Redis trouble just means no cache (the old
// behaviour), never an error.
const INSIGHT_CACHE_TTL_SECONDS = 6 * 60 * 60;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cachedInsight(sql: Sql, env: Env, input: Parameters<typeof generateInsight>[2], tenant: TenantContext): Promise<string> {
  let key: string | null = null;
  try {
    key = `insight:v1:${tenant.tenantId}:${await sha256Hex(JSON.stringify(input))}`;
    const hit = await upstash(env, "GET", key);
    if (typeof hit === "string" && hit.length > 0) return hit;
  } catch {
    key = null; // cache unavailable — fall through and generate
  }
  const fresh = await generateInsight(sql, env, input, tenant);
  if (key && fresh) await upstash(env, "SET", key, fresh, "EX", INSIGHT_CACHE_TTL_SECONDS).catch(() => {});
  return fresh;
}

// --- Business insights (GET /dashboard/insights) --------------------------

export interface ITCRiskItem {
  documentId: string;
  vendorName: string;
  invoiceNumber?: string;
  taxAmount: number;
  reason: string;
}
export interface VendorFollowUp {
  vendorName: string;
  totalTaxAtRisk: number;
  openIssueCount: number;
  reasons: string[];
}
export interface FilingDeadline {
  returnType: string;
  period: string;
  dueDate: string;
  daysRemaining: number;
  approaching: boolean;
}
export interface BusinessInsights {
  highestItcRiskToday: ITCRiskItem[];
  vendorsRequiringFollowUp: VendorFollowUp[];
  filingDeadlines: FilingDeadline[];
  estimatedRecoverableItc: number;
  generatedAt: string;
}

const MAX_LIST_ITEMS = 10;
const APPROACHING_WITHIN_DAYS = 7;

export async function buildBusinessInsights(sql: Sql, tenantId: string): Promise<BusinessInsights> {
  const [notFiled, mismatch] = await Promise.all([
    listByGSTStatus(sql, tenantId, "NOT_FILED"),
    listByGSTStatus(sql, tenantId, "MISMATCH"),
  ]);

  const riskItems: ITCRiskItem[] = [];
  const vendorTotals = new Map<string, VendorFollowUp>();
  let recoverable = 0;

  const addDoc = (d: DocumentRow, reason: string) => {
    const taxAmount = parseFloat(d.taxAmount ?? "0");
    recoverable += taxAmount;
    riskItems.push({ documentId: d.documentId, vendorName: d.vendorName ?? "", invoiceNumber: d.invoiceNumber ?? undefined, taxAmount, reason });
    const key = (d.vendorName ?? "").toLowerCase().trim();
    if (!key) return;
    let vf = vendorTotals.get(key);
    if (!vf) {
      vf = { vendorName: d.vendorName ?? "", totalTaxAtRisk: 0, openIssueCount: 0, reasons: [] };
      vendorTotals.set(key, vf);
    }
    vf.totalTaxAtRisk += taxAmount;
    vf.openIssueCount++;
    vf.reasons.push(reason);
  };
  for (const d of notFiled) addDoc(d, "Vendor hasn't filed this invoice on the GST portal yet");
  for (const d of mismatch) addDoc(d, "Invoice details don't match what's on the GST portal");

  riskItems.sort((a, b) => b.taxAmount - a.taxAmount);
  const vendors = [...vendorTotals.values()].sort((a, b) => b.totalTaxAtRisk - a.totalTaxAtRisk);

  return {
    highestItcRiskToday: riskItems.slice(0, MAX_LIST_ITEMS),
    vendorsRequiringFollowUp: vendors.slice(0, MAX_LIST_ITEMS),
    filingDeadlines: computeFilingDeadlines(new Date()),
    estimatedRecoverableItc: recoverable,
    generatedAt: new Date().toISOString(),
  };
}

// Standard monthly-filer calendar (GSTR-1 by the 11th, GSTR-3B by the
// 20th of the following month) — doesn't yet account for QRMP quarterly
// filers or state-specific staggered GSTR-3B due dates (22nd/24th),
// same caveat the Go source flagged.
function computeFilingDeadlines(today: Date): FilingDeadline[] {
  const nextOccurrence = (dayOfMonth: number): Date => {
    let candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), dayOfMonth));
    if (candidate < today) candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, dayOfMonth));
    return candidate;
  };
  const build = (returnType: string, dayOfMonth: number): FilingDeadline => {
    const due = nextOccurrence(dayOfMonth);
    const periodBeingFiled = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() - 1, 1));
    const daysRemaining = Math.round((due.getTime() - today.getTime()) / 86_400_000);
    return {
      returnType,
      period: periodBeingFiled.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      dueDate: due.toISOString().slice(0, 10),
      daysRemaining,
      approaching: daysRemaining <= APPROACHING_WITHIN_DAYS,
    };
  };
  return [build("GSTR-1", 11), build("GSTR-3B", 20)];
}
