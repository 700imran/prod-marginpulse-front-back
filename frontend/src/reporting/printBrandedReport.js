import { printMarginPulseReport } from "./printBrandedReport";

function formatINR(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function printDashboardReport({
  tenant,
  summary,
  anomalies,
  insights,
  generatedAt = new Date(),
}) {
  const m = summary?.summaryMetrics || {};
  const businessName = tenant?.businessName || tenant?.displayName || "Your workspace";

  const summaryRows = [
    ["Total documents", m.totalUploadedDocuments ?? 0],
    ["Auto-matched", m.successfullyReconciledCount ?? 0],
    ["Needs action", m.unreconciledAnomaliesDetected ?? 0],
    ["GST gaps", m.gstMismatchFlagCount ?? 0],
    ["Estimated recoverable ITC", formatINR(insights?.estimatedRecoverableItc ?? 0)],
  ];

  const anomalyRows = (anomalies || []).slice(0, 12).map((a) => [
    a.anomalyType || "Anomaly",
    a.severity || "MEDIUM",
    a.description || "No description",
  ]);

  const riskRows = (insights?.highestItcRiskToday || []).slice(0, 8).map((item) => [
    item.vendorName || "Unknown vendor",
    formatINR(item.taxAmount || 0),
    item.reason || "Review needed",
  ]);

  return printMarginPulseReport({
    title: "MarginPulse Reconciliation Report",
    subtitle: `${businessName} · Financial reconciliation overview`,
    generatedAt,
    summaryRows,
    sections: [
      {
        heading: "Open anomalies",
        rows: anomalyRows.length ? anomalyRows : [["No open anomalies", "-", "Everything is reconciled."]],
      },
      {
        heading: "Highest ITC risk today",
        rows: riskRows.length ? riskRows : [["No risk found", "₹0", "No vendor currently requires follow-up."]],
      },
    ],
  });
}
