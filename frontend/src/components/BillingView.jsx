/**
 * BillingView.jsx — intentionally static. No payment provider (Stripe/
 * Razorpay) has been integrated, so the "Upgrade" action here is
 * explicitly disabled with a clear label rather than wired to a fake
 * checkout that charges nobody — a non-functional button that looks
 * functional is worse than one that's honestly marked "coming soon".
 */
export default function BillingView({ tenant }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h3 style={{ fontSize: 18 }}>Current Plan: {tenant?.plan_tier === "FREE" ? "Auditor Free" : tenant?.plan_tier || "Auditor Free"}</h3>
        <span className="nav-badge badge-pro" style={{ padding: "4px 8px" }}>Payments not yet connected</span>
      </div>

      <h4 style={{ marginBottom: 16, fontSize: 16 }}>Pro Features Include:</h4>
      <ul style={{ listStyle: "none", lineHeight: 2.2, color: "var(--text-gray)", marginBottom: 30, fontSize: 14 }}>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Unlimited Document Extraction</li>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Multi-currency Reconciliation</li>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Audit Team Management (Invite CAs)</li>
        <li><strong style={{ color: "var(--primary-color)" }}>✓</strong> Automated GSTR-3B Drafting</li>
      </ul>
      <button className="btn btn-primary" disabled style={{ background: "var(--text-gray)" }}>
        Upgrade to Pro — payment provider not yet connected
      </button>
      <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 14 }}>
        Billing requires connecting a real payment provider (e.g. Stripe or Razorpay) —
        this is intentionally left disabled rather than faked.
      </p>
    </div>
  );
}
