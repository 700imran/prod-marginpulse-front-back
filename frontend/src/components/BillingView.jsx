/**
 * BillingView.jsx — plan selection + Razorpay checkout.
 * The payment logic lives in ../payments/razorpay.js (timeouts, retry-safe script loader, inline status);
 * this file is only the screen. Plan prices here are DISPLAY ONLY — the server sets the real price.
 */
import { useEffect, useRef, useState } from "react";
import { startPayment, retryVerification, loadRazorpayScript } from "../payments/razorpay";
import { clearDataCache } from "../api";

export { startPayment };

const PLAN_OPTIONS = [
  { id: "starter", label: "Starter", price: 499, description: "For solo practitioners" },
  { id: "pro", label: "Pro", price: 1499, description: "Best for growing teams" },
  { id: "enterprise", label: "Enterprise", price: 4999, description: "Advanced controls & scale" },
];

export default function BillingView({ tenant }) {
  const [status, setStatus] = useState({ stage: "idle", message: "" });
  const [selectedPlanId, setSelectedPlanId] = useState("pro");
  const reloadTimer = useRef(null);
  const busy = status.stage === "preparing" || status.stage === "verifying";
  const planLabel = tenant?.planTier === "FREE" ? "Auditor Free" : tenant?.planTier || "Auditor Free";
  const selectedPlan = PLAN_OPTIONS.find((plan) => plan.id === selectedPlanId) || PLAN_OPTIONS[1];

  // Load Razorpay's script while the page is idle so the click opens the payment window immediately.
  useEffect(() => {
    loadRazorpayScript().catch(() => { /* surfaced with a clear message if the user actually clicks Pay */ });
    return () => clearTimeout(reloadTimer.current);
  }, []);

  const onStatus = (next) => {
    setStatus(next);
    if (next.stage === "success") {
      try { sessionStorage.removeItem("mp_profile"); } catch { /* ignore */ }
      clearDataCache();
      reloadTimer.current = setTimeout(() => window.location.reload(), 1500); // pick up the upgraded plan
    }
  };
  const handleUpgrade = () => startPayment(selectedPlan.id, { onStatus });
  const handleRetry = () => retryVerification({ onStatus });

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h3 style={{ fontSize: 18 }}>Current Plan: {planLabel}</h3>
        <span className="nav-badge badge-pro" style={{ padding: "4px 8px" }}>Razorpay ready</span>
      </div>

      <h4 style={{ marginBottom: 16, fontSize: 16 }}>Choose a plan</h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 24 }}>
        {PLAN_OPTIONS.map((plan) => {
          const active = plan.id === selectedPlanId;
          return (
            <button
              key={plan.id}
              type="button"
              onClick={() => setSelectedPlanId(plan.id)}
              style={{
                textAlign: "left",
                padding: 16,
                borderRadius: 12,
                border: active ? "2px solid var(--primary-color)" : "1px solid rgba(255,255,255,0.1)",
                background: active ? "rgba(24, 196, 150, 0.08)" : "rgba(255,255,255,0.02)",
                color: "var(--text-primary)",
                cursor: "pointer",
                transition: "all 0.2s ease",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{plan.label}</div>
              <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 6 }}>₹{plan.price}</div>
              <div style={{ fontSize: 12, color: "var(--text-gray)" }}>{plan.description}</div>
            </button>
          );
        })}
      </div>

      <h4 style={{ marginBottom: 16, fontSize: 16 }}>Pro Features Include:</h4>
      <ul style={{ listStyle: "none", lineHeight: 2.2, color: "var(--text-gray)", marginBottom: 30, fontSize: 14 }}>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Unlimited Document Extraction</li>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Multi-currency Reconciliation</li>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Audit Team Management (Invite CAs)</li>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Automated GSTR-3B Drafting</li>
      </ul>

      <button
        className="btn btn-primary"
        onClick={handleUpgrade}
        disabled={busy || status.stage === "awaiting" || status.stage === "success"}
        aria-busy={busy}
        style={{ opacity: busy ? 0.7 : 1 }}
      >
        {status.stage === "preparing" ? "Opening secure payment…"
          : status.stage === "verifying" ? "Confirming payment…"
          : status.stage === "awaiting" ? "Complete payment in the window"
          : `Upgrade to ${selectedPlan.label} — ₹${selectedPlan.price}`}
      </button>

      {status.message && (
        <div
          role={status.stage === "error" ? "alert" : "status"}
          style={{
            marginTop: 14, padding: "10px 14px", borderRadius: 12, fontSize: 14, lineHeight: 1.5,
            background: status.stage === "error" ? "#fdecea" : status.stage === "success" ? "#eafbf5" : "#f2f4f7",
            color: status.stage === "error" ? "#b42318" : status.stage === "success" ? "#0f6e56" : "#344054",
          }}
        >
          {busy && <span className="mp-auth-spinner" aria-hidden="true" style={{ display: "inline-block", marginRight: 8 }}></span>}
          {status.message}
          {status.retry && (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-primary" onClick={handleRetry} disabled={busy}>Retry confirmation</button>
            </div>
          )}
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 14 }}>
        Payments are processed securely by Razorpay. Your plan is activated only after the payment is confirmed by our server.
      </p>
    </div>
  );
}
