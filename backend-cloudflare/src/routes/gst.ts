import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { requireFeature } from "../billing/featureGate";
import { listInvoicesWithTaxIdentifier, listByGSTStatus } from "../repository/documents";
import { requestGstSync } from "../actions/gst";
import { apiError } from "../http";

export const gstRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

gstRoutes.use("*", requireAuth);
gstRoutes.use("*", requireFeature("gst_sync")); // plan-gated: a no-op unless ENFORCE_PLAN_GATING=true

// POST /gst/sync?period=MMYYYY — a GSTR-2B fetch is a paid external call,
// so this reserves usage credits atomically before enqueueing the job.
// If the job later fails permanently (dead-letter queue), the reservation
// is refunded — see queue/consumer.ts's handleDeadLetterBatch.
gstRoutes.post("/sync", async (c) => {
  const tenant = c.get("tenant");
  const period = c.req.query("period") ?? "";
  const result = await requestGstSync(c.env, c.get("sql"), tenant, period);
  if (!result.ok) {
    if (result.reason === "NO_GSTIN") return apiError(c, 400, "VALIDATION_ERROR", "No GSTIN registered for this account");
    return apiError(c, 402, "INSUFFICIENT_CREDITS", "Not enough usage credits for a GST sync this billing period", { credits_remaining: result.creditsRemaining });
  }
  return c.json({ job_id: result.jobId, gstin: result.gstin, credits_remaining: result.creditsRemaining }, 202);
});

// worseStatus ranks GST statuses worst-first so a vendor with even one
// problem invoice shows that problem, rather than being averaged away
// by other invoices that are fine.
const STATUS_RANK: Record<string, number> = { MISMATCH: 3, NOT_FILED: 2, PENDING: 1, FILED: 0, "": 1 };
function worseStatus(a: string, b: string): string {
  return (STATUS_RANK[b] ?? 1) > (STATUS_RANK[a] ?? 1) ? b : a;
}

gstRoutes.get("/vendor-status", async (c) => {
  const docs = await listInvoicesWithTaxIdentifier(c.get("sql"), c.get("tenant").tenantId);

  const byVendor = new Map<string, { vendorName: string; gstin: string; invoiceCount: number; totalInvoiceAmount: number; gstPortalStatus: string }>();
  for (const d of docs) {
    const key = d.taxIdentifier ?? "";
    let v = byVendor.get(key);
    if (!v) {
      v = { vendorName: d.vendorName ?? "", gstin: key, invoiceCount: 0, totalInvoiceAmount: 0, gstPortalStatus: "PENDING" };
      byVendor.set(key, v);
    }
    v.invoiceCount++;
    v.totalInvoiceAmount += parseFloat(d.rawTotalAmount ?? "0");
    v.gstPortalStatus = worseStatus(v.gstPortalStatus, d.gstPortalStatus);
  }
  const vendors = [...byVendor.keys()].sort().map((k) => byVendor.get(k)!);
  return c.json({ vendors });
});

gstRoutes.get("/itc-summary", async (c) => {
  const sql = c.get("sql");
  const tenantId = c.get("tenant").tenantId;
  const filed = await listByGSTStatus(sql, tenantId, "FILED");
  const notFiled = await listByGSTStatus(sql, tenantId, "NOT_FILED").catch(() => []);
  const mismatch = await listByGSTStatus(sql, tenantId, "MISMATCH").catch(() => []);

  const claimable = filed.reduce((sum, d) => sum + parseFloat(d.taxAmount ?? "0"), 0);
  const atRisk = [...notFiled, ...mismatch].reduce((sum, d) => sum + parseFloat(d.taxAmount ?? "0"), 0);

  return c.json({ itc_claimable_inr: claimable, itc_at_risk_inr: atRisk });
});
