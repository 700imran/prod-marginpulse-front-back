/**
 * DashboardView.jsx — real data from GET /api/v1/reconciliation/dashboard-summary
 * and GET /api/v1/reconciliation/anomalies, styled in the neomorphism theme.
 *
 * Includes an onboarding guide (OnboardingGuide below) for brand-new
 * accounts — a blank dashboard with all-zero stat cards previously gave
 * no indication of what to do next. The guide computes each step's
 * completion from real data (document count, bank account count, GSTIN
 * presence) rather than a fixed "have you clicked this before" flag, so
 * it always reflects actual account state even across devices/browsers.
 */
import { useState, useEffect } from "react";
import {
  getDashboard, listAnomalies, resolveAnomaly, uploadDocument, triggerReconciliation,
  listBankAccounts, listTaxIdentifiers, getDashboardInsights, downloadReconciliationReport,
  detectMissingInvoices,
} from "../api";

function StatCard({ value, label, accent }) {
  return (
    <div className="card" style={{ flex: 1, borderTop: `3px solid ${accent}`, marginBottom: 0 }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: "var(--text-dark)", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-gray)", marginTop: 6 }}>{label}</div>
    </div>
  );
}

function SeverityDot({ severity }) {
  const colors = { CRITICAL: "var(--danger-color)", HIGH: "var(--warning-color)", MEDIUM: "#6366f1" };
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: colors[severity] || "var(--text-gray)", marginRight: 8, flexShrink: 0 }} />;
}

function formatINR(amount) {
  const n = Number(amount || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/**
 * The "what should I do today" business dashboard — highest ITC risk,
 * vendors needing a nudge, and upcoming GST filing deadlines. Separate
 * from the mismatch-count stat cards above: those answer "what didn't
 * match", this answers "what should I act on right now".
 */
function InsightsSection({ insights, onExport, onDetectMissing, detecting }) {
  if (!insights) return null;
  const risk = insights.highest_itc_risk_today || [];
  const vendors = insights.vendors_requiring_follow_up || [];
  const deadlines = insights.filing_deadlines || [];

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 18, marginBottom: 4 }}>Today's Priorities</h3>
          <p style={{ fontSize: 13, color: "var(--text-gray)" }}>
            Estimated recoverable ITC: <strong style={{ color: "var(--text-dark)" }}>{formatINR(insights.estimated_recoverable_itc)}</strong>
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" onClick={onDetectMissing} disabled={detecting}>
            {detecting ? "Scanning…" : "Scan for Missing Invoices"}
          </button>
          <button className="btn btn-ghost" onClick={onExport}>Download Report (CSV)</button>
        </div>
      </div>

      {deadlines.length > 0 && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          {deadlines.map((d) => (
            <div
              key={d.return_type}
              style={{
                flex: "1 1 200px", padding: "14px 16px", borderRadius: 12,
                background: d.approaching ? "rgba(245,166,35,0.1)" : "var(--bg-color)",
                border: d.approaching ? "1px solid var(--warning-color)" : "1px solid transparent",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: d.approaching ? "var(--warning-color)" : "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {d.return_type} · {d.period}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
                Due {d.due_date} {d.approaching ? `— ${d.days_remaining} day${d.days_remaining === 1 ? "" : "s"} left` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid-2" style={{ gap: 20 }}>
        <div>
          <h4 style={{ fontSize: 14, marginBottom: 10, color: "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Highest ITC Risk Today
          </h4>
          {risk.length === 0 && <p style={{ fontSize: 13, color: "var(--text-gray)" }}>Nothing at risk right now.</p>}
          {risk.map((item) => (
            <div key={item.document_id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-color)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}>
                <span>{item.vendor_name || "Unknown vendor"}</span>
                <span>{formatINR(item.tax_amount)}</span>
              </div>
              <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 2 }}>{item.reason}</p>
            </div>
          ))}
        </div>
        <div>
          <h4 style={{ fontSize: 14, marginBottom: 10, color: "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Vendors Requiring Follow-Up
          </h4>
          {vendors.length === 0 && <p style={{ fontSize: 13, color: "var(--text-gray)" }}>No vendors need a nudge right now.</p>}
          {vendors.map((v) => (
            <div key={v.vendor_name} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-color)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}>
                <span>{v.vendor_name}</span>
                <span>{formatINR(v.total_tax_at_risk)}</span>
              </div>
              <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 2 }}>
                {v.open_issue_count} open issue{v.open_issue_count === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const ONBOARDING_DISMISSED_KEY = "mp_onboarding_dismissed";

/** One row in the getting-started checklist. */
function OnboardingStep({ number, title, description, done, ctaLabel, onClick }) {
  return (
    <div
      className="list-row"
      style={{
        alignItems: "flex-start",
        opacity: done ? 0.6 : 1,
        background: done ? "transparent" : "var(--primary-light)",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", gap: 14, flex: 1 }}>
        <div
          style={{
            flexShrink: 0, width: 28, height: 28, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 800,
            background: done ? "var(--primary-color)" : "#fff",
            color: done ? "#fff" : "var(--text-dark)",
            border: done ? "none" : "2px solid var(--primary-color)",
          }}
        >
          {done ? "✓" : number}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 3, textDecoration: done ? "line-through" : "none" }}>
            {title}
          </div>
          <p style={{ fontSize: 13, color: "var(--text-gray)", margin: 0 }}>{description}</p>
        </div>
      </div>
      {!done && (
        <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={onClick}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Getting-started guide, shown until the user dismisses it or completes
 * every step. Always visible (not just when total docs === 0) until
 * dismissed, so users who upload one document but never link a bank
 * account still get reminded — a single upload doesn't mean onboarding
 * is actually finished.
 */
function OnboardingGuide({ steps, allDone, onDismiss }) {
  const completedCount = steps.filter((s) => s.done).length;

  return (
    <div className="card" style={{ border: "2px solid var(--primary-color)", position: "relative" }}>
      <button
        onClick={onDismiss}
        title="Hide this guide"
        style={{
          position: "absolute", top: 14, right: 14, background: "none", border: "none",
          color: "var(--text-gray)", cursor: "pointer", fontSize: 13, fontWeight: 600,
        }}
      >
        Hide guide ✕
      </button>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--primary-color)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
          {allDone ? "Setup complete" : "Getting started"}
        </div>
        <h3 style={{ fontSize: 20, marginBottom: 4 }}>
          {allDone ? "You're all set 🎉" : "Where do I start?"}
        </h3>
        <p style={{ fontSize: 13, color: "var(--text-gray)" }}>
          {allDone
            ? "Every setup step is complete. New documents you upload will reconcile automatically."
            : `${completedCount} of ${steps.length} steps done — finish these to get your first automatic reconciliation.`}
        </p>
      </div>

      {!allDone && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {steps.map((step, i) => (
            <OnboardingStep key={step.id} number={i + 1} {...step} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardView({ onToast, tenant, onNavigate }) {
  const [summary, setSummary] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [bankAccountCount, setBankAccountCount] = useState(null);
  const [taxIdentifierCount, setTaxIdentifierCount] = useState(null);
  const [insights, setInsights] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [guideHidden, setGuideHidden] = useState(() => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1");

  async function refresh() {
    const [dash, anom, bankAccounts, taxIds, dashInsights] = await Promise.all([
      getDashboard(),
      listAnomalies("OPEN"),
      listBankAccounts(),
      listTaxIdentifiers(),
      getDashboardInsights(),
    ]);
    if (dash?.summary_metrics) setSummary(dash);
    if (anom?.items) setAnomalies(anom.items);
    if (Array.isArray(bankAccounts)) setBankAccountCount(bankAccounts.length);
    if (Array.isArray(taxIds)) setTaxIdentifierCount(taxIds.length);
    if (dashInsights?.generated_at) setInsights(dashInsights);
    setLoading(false);
  }

  useEffect(() => { refresh(); }, []);

  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const result = await uploadDocument(file, "INVOICE");
    setUploading(false);
    e.target.value = "";
    if (result?.tracking_job_id) {
      onToast?.("Document queued for processing", "success");
      setTimeout(refresh, 3000);
    } else {
      onToast?.(result?.detail || "Upload failed", "error");
    }
  }

  async function handleResolve(anomalyId) {
    const result = await resolveAnomaly(anomalyId);
    if (result?.status === "RESOLVED") {
      setAnomalies((prev) => prev.filter((a) => a.anomaly_id !== anomalyId));
      onToast?.("Anomaly resolved", "success");
    }
  }

  async function handleRunReconciliation() {
    const result = await triggerReconciliation();
    if (result?.job_id) {
      onToast?.(`Reconciliation queued for ${result.documents_queued} documents`, "success");
      setTimeout(refresh, 3000);
    }
  }

  async function handleExport() {
    const ok = await downloadReconciliationReport();
    onToast?.(ok ? "Report downloaded" : "Could not generate report", ok ? "success" : "error");
  }

  async function handleDetectMissing() {
    setDetecting(true);
    const result = await detectMissingInvoices();
    setDetecting(false);
    if (result && typeof result.anomalies_created === "number") {
      onToast?.(
        result.anomalies_created > 0
          ? `Found ${result.anomalies_created} possible missing invoice${result.anomalies_created === 1 ? "" : "s"}`
          : "No missing invoices found",
        "success"
      );
      if (result.anomalies_created > 0) setTimeout(refresh, 1000);
    } else {
      onToast?.("Could not run missing-invoice scan", "error");
    }
  }

  function dismissGuide() {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    setGuideHidden(true);
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading dashboard…</p></div>;

  const m = summary?.summary_metrics || {};

  const hasDocuments = (m.total_uploaded_documents ?? 0) > 0;
  const hasBankAccount = (bankAccountCount ?? 0) > 0;
  const hasGSTIN = Boolean(tenant?.gstin_number) || (taxIdentifierCount ?? 0) > 0;

  const onboardingSteps = [
    {
      id: "upload",
      title: "Upload your first invoice or bill",
      description: "PDF, image, or scanned document — we'll extract the vendor, amount, and date automatically.",
      done: hasDocuments,
      ctaLabel: "Go to Documents",
      onClick: () => onNavigate?.("documents"),
    },
    {
      id: "bank",
      title: "Link a bank account",
      description: "Add your business bank account (or upload a statement CSV) so incoming payments can be matched.",
      done: hasBankAccount,
      ctaLabel: "Link Bank Account",
      onClick: () => onNavigate?.("taxbank"),
    },
    {
      id: "gstin",
      title: "Register your GSTIN",
      description: "Add your business GST number to enable ITC risk tracking and vendor filing checks.",
      done: hasGSTIN,
      ctaLabel: "Add GSTIN",
      onClick: () => onNavigate?.("taxbank"),
    },
    {
      id: "sync",
      title: "Sync with the GST portal",
      description: "Cross-check your invoices against what your vendors have actually filed on GSTR-2B.",
      done: false,
      ctaLabel: "Go to Tax Portal Sync",
      onClick: () => onNavigate?.("gst"),
    },
  ];
  const allStepsDone = onboardingSteps.every((s) => s.done);
  const showGuide = !guideHidden && !allStepsDone;

  return (
    <>
      {showGuide && (
        <div style={{ marginBottom: 24 }}>
          <OnboardingGuide steps={onboardingSteps} allDone={allStepsDone} onDismiss={dismissGuide} />
        </div>
      )}

      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard value={m.total_uploaded_documents ?? 0} label="Total Documents" accent="var(--text-dark)" />
        <StatCard value={m.successfully_reconciled_count ?? 0} label="Auto-Matched" accent="var(--primary-color)" />
        <StatCard value={m.unreconciled_anomalies_detected ?? 0} label="Needs Action" accent="var(--warning-color)" />
        <StatCard value={m.gst_mismatch_flag_count ?? 0} label="GST Gaps" accent="var(--danger-color)" />
      </div>

      <div style={{ marginBottom: 24 }}>
        <InsightsSection insights={insights} onExport={handleExport} onDetectMissing={handleDetectMissing} detecting={detecting} />
      </div>

      {summary?.plain_english_insight && (
        <div className="card" style={{ background: "var(--primary-light)", borderLeft: "4px solid var(--primary-color)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--primary-color)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
            AI Insight
          </div>
          <p style={{ fontSize: 14, color: "var(--text-dark)", lineHeight: 1.6 }}>{summary.plain_english_insight}</p>
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ fontSize: 18 }}>Action Required</h3>
          <div style={{ display: "flex", gap: 10 }}>
            {guideHidden && !allStepsDone && (
              <button className="btn btn-ghost" onClick={() => { localStorage.removeItem(ONBOARDING_DISMISSED_KEY); setGuideHidden(false); }}>
                Show Setup Guide
              </button>
            )}
            <label className="btn btn-ghost" style={{ cursor: uploading ? "not-allowed" : "pointer" }}>
              {uploading ? "Uploading…" : "+ Upload Document"}
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.csv" onChange={handleFileUpload} disabled={uploading} style={{ display: "none" }} />
            </label>
            <button className="btn btn-primary" onClick={handleRunReconciliation}>Run Reconciliation</button>
          </div>
        </div>
        {anomalies.length === 0 && <p style={{ color: "var(--text-gray)", fontSize: 13 }}>No open anomalies — everything is reconciled.</p>}
        {anomalies.map((a) => (
          <div className="list-row" key={a.anomaly_id}>
            <div>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                <SeverityDot severity={a.severity} />
                <span style={{ fontWeight: 700, fontSize: 14 }}>{a.type}</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-gray)", paddingLeft: 16 }}>{a.description}</p>
            </div>
            <button className="btn btn-ghost" style={{ flexShrink: 0 }} onClick={() => handleResolve(a.anomaly_id)}>
              Mark Resolved
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
