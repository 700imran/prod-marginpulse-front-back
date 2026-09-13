// Port of two things that both feed the dashboard:
//  1. reconciliation_handlers.go's HandleDashboardSummary (counts +
//     plain-English insight) -> buildDashboardSummary
//  2. pipelines/dashboard/insights.go's Build (the "what to do today"
//     ITC-risk / vendor follow-up / filing-deadline view) -> buildBusinessInsights
import type { Sql } from "../db";
import type { Env } from "../config";
import { countDocumentsByTenant, countDocumentsByStatus, listByGSTStatus, type DocumentRow } from "../repository/documents";
import { listAnomalies } from "../repository/anomalies";
import { generateInsight } from "./insights";

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

export async function buildDashboardSummary(sql: Sql, env: Env, tenantId: string): Promise<DashboardSummary> {
  const total = await countDocumentsByTenant(sql, tenantId);
  const reconciled = await countDocumentsByStatus(sql, tenantId, "RECONCILED");

  // Mirrors the Go handler's own comment: this intentionally uses a
  // capped list(20) as both the anomaly source AND the displayed count,
  // matching the original Python behavior it was ported from.
  const openAnomalies = await listAnomalies(sql, tenantId, "OPEN", 20, 0);
  const gstMismatchCount = openAnomalies.filter((a) => a.anomalyType === "TAX_PORTAL_MISMATCH").length;

  const notFiledDocs = await listByGSTStatus(sql, tenantId, "NOT_FILED").catch(() => [] as DocumentRow[]);
  const mismatchDocs = await listByGSTStatus(sql, tenantId, "MISMATCH").catch(() => [] as DocumentRow[]);

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

  const plainEnglish = await generateInsight(
    env,
    {
      totalUploadedDocuments: total,
      successfullyReconciledCount: reconciled,
      unreconciledAnomaliesDetected: openAnomalies.length,
      gstMismatchFlagCount: gstMismatchCount,
      itcAtRisk,
      gstProblemVendors: problemVendors,
      anomalyBreakdown: {},
      period: "",
    },
    tenantId,
  );

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
  const notFiled = await listByGSTStatus(sql, tenantId, "NOT_FILED");
  const mismatch = await listByGSTStatus(sql, tenantId, "MISMATCH");

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
