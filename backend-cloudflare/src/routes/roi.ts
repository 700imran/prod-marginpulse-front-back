import { Hono } from "hono";
import type { Env } from "../config";

// Deliberately unauthenticated — no requireAuth here, matching the Go
// original's own comment: meant to sit on the public marketing site as
// well as inside the logged-in dashboard. Pure arithmetic, no
// persistence, nothing worth rate-limiting.
export const roiRoutes = new Hono<{ Bindings: Env }>();

const ITC_LEAKAGE_RATE_PERCENT_DEFAULT = 8.0;
const TIME_SAVED_PERCENT_DEFAULT = 70.0;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

roiRoutes.post("/", async (c) => {
  const req = await c.req.json().catch(() => null);
  if (!req) return c.json({ error: "Invalid request body" }, 400);

  const monthlyInvoiceVolume = Number(req.monthly_invoice_volume ?? 0);
  const avgInvoiceValueINR = Number(req.avg_invoice_value_inr ?? 0);
  const hoursSpentManuallyPerMonth = Number(req.hours_spent_manually_per_month ?? 0);
  const hourlyCostINR = Number(req.hourly_cost_inr ?? 0);
  const monthlyPlanPriceINR = Number(req.monthly_plan_price_inr ?? 0);

  if ([monthlyInvoiceVolume, avgInvoiceValueINR, hoursSpentManuallyPerMonth, hourlyCostINR, monthlyPlanPriceINR].some((v) => v < 0)) {
    return c.json({ error: "Inputs must be non-negative" }, 422);
  }

  const gstRate = req.avg_gst_rate_percent != null ? Number(req.avg_gst_rate_percent) : 18.0;
  const itcLeakageRate = req.itc_leakage_rate_percent != null ? Number(req.itc_leakage_rate_percent) : ITC_LEAKAGE_RATE_PERCENT_DEFAULT;
  const timeSavedRate = req.time_saved_percent != null ? Number(req.time_saved_percent) : TIME_SAVED_PERCENT_DEFAULT;

  const monthlyGSTValue = monthlyInvoiceVolume * avgInvoiceValueINR * (gstRate / 100);
  const estimatedITCRecovered = monthlyGSTValue * (itcLeakageRate / 100);
  const hoursSaved = hoursSpentManuallyPerMonth * (timeSavedRate / 100);
  const timeSavingsINR = hoursSaved * hourlyCostINR;
  const totalMonthlyValue = estimatedITCRecovered + timeSavingsINR;
  const netROI = totalMonthlyValue - monthlyPlanPriceINR;
  const roiMultiple = monthlyPlanPriceINR > 0 ? totalMonthlyValue / monthlyPlanPriceINR : 0;

  const results = {
    monthly_gst_value_inr: round2(monthlyGSTValue),
    estimated_monthly_itc_recovered_inr: round2(estimatedITCRecovered),
    hours_saved_per_month: round2(hoursSaved),
    monthly_time_savings_inr: round2(timeSavingsINR),
    total_monthly_value_inr: round2(totalMonthlyValue),
    net_monthly_roi_inr: round2(netROI),
    roi_multiple: round2(roiMultiple),
  };

  return c.json({
    inputs: {
      monthly_invoice_volume: monthlyInvoiceVolume, avg_invoice_value_inr: avgInvoiceValueINR, avg_gst_rate_percent: gstRate,
      hours_spent_manually_per_month: hoursSpentManuallyPerMonth, hourly_cost_inr: hourlyCostINR, monthly_plan_price_inr: monthlyPlanPriceINR,
    },
    assumptions_used: {
      itc_leakage_rate_percent: itcLeakageRate, time_saved_percent: timeSavedRate,
      note: "These are editable planning assumptions, not guarantees — pass itc_leakage_rate_percent / time_saved_percent to override with your own numbers.",
    },
    results,
    summary: `At this volume, MarginPulse could help recover roughly ₹${results.estimated_monthly_itc_recovered_inr.toFixed(0)} in ITC and save ${results.hours_saved_per_month.toFixed(0)} hours (₹${results.monthly_time_savings_inr.toFixed(0)}) of manual work per month — about ₹${results.total_monthly_value_inr.toFixed(0)} in total monthly value against a ₹${monthlyPlanPriceINR.toFixed(0)} plan cost.`,
  });
});
