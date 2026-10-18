// The one implementation of "request a GST sync", shared by
// POST /gst/sync (routes/gst.ts) and the assistant's confirmed `sync_gst`
// action (assistant/tools.ts). Extracted so the assistant is never a
// second, parallel path to a paid operation — it reserves credits and
// enqueues through exactly this code, the same as the button does.
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { reserveForOperation } from "../billing/guard";

export type GstSyncRequestResult =
  | { ok: true; jobId: string; gstin: string; creditsReserved: number; creditsRemaining: number }
  | { ok: false; reason: "NO_GSTIN" }
  | { ok: false; reason: "INSUFFICIENT_CREDITS"; creditsRemaining: number };

export async function requestGstSync(env: Env, sql: Sql, tenant: TenantContext, period: string): Promise<GstSyncRequestResult> {
  if (!tenant.gstinNumber) return { ok: false, reason: "NO_GSTIN" };

  const jobId = crypto.randomUUID();
  const reservation = await reserveForOperation(sql, tenant, "GST_SYNC", jobId);
  if (!reservation.ok) {
    return { ok: false, reason: "INSUFFICIENT_CREDITS", creditsRemaining: reservation.balanceAfter };
  }

  await env.GST_QUEUE.send({
    task: "sync_gst_portal", job_id: jobId,
    args: { tenant_id: tenant.tenantId, gstin: tenant.gstinNumber, period },
    credit_reservation: { tenant_id: tenant.tenantId, operation: "GST_SYNC", amount: reservation.amount },
  });
  return { ok: true, jobId, gstin: tenant.gstinNumber, creditsReserved: reservation.amount, creditsRemaining: reservation.balanceAfter };
}
