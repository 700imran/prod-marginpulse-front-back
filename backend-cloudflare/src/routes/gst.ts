import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { listInvoicesWithTaxIdentifier, listByGSTStatus } from "../repository/documents";

export const gstRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

gstRoutes.use("*", requireAuth);

// POST /gst/sync?period=MMYYYY
gstRoutes.post("/sync", async (c) => {
  const tenant = c.get("tenant");
  const period = c.req.query("period") ?? "";
  if (!tenant.gstinNumber) return c.json({ error: "No GSTIN registered for this account" }, 400);

  const jobId = crypto.randomUUID();
  await c.env.GST_QUEUE.send({ task: "sync_gst_portal", job_id: jobId, args: { tenant_id: tenant.tenantId, gstin: tenant.gstinNumber, period } });
  return c.json({ job_id: jobId, gstin: tenant.gstinNumber }, 202);
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
