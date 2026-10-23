/**
 * BillingView — plans, pricing and checkout.
 *
 * Money rules (mirrored on the server, backend billing routes):
 *  - the browser only NAMES a plan; the server decides the price and creates the order;
 *  - "payment successful" is shown only after the server has confirmed the payment with
 *    Razorpay — Razorpay's browser callback alone proves nothing;
 *  - if the browser closes mid-payment, Razorpay's webhook still activates the plan.
 * All customer-facing text here is rendered as plain text.
 */
import { useState, useRef, useEffect } from "react";
import { createCheckout, verifyPayment } from "../api";
import { formatExpiry } from "../planLogic";

const RZP_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

export function loadRazorpay() {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById("razorpay-checkout-script");
    const done = () => (window.Razorpay ? resolve() : reject(new Error("Razorpay failed to load.")));
    if (existing) { existing.addEventListener("load", done, { once: true }); existing.addEventListener("error", () => reject(new Error("Razorpay failed to load.")), { once: true }); return; }
    const s = document.createElement("script");
    s.id = "razorpay-checkout-script"; s.src = RZP_SCRIPT; s.async = true;
    s.onload = done; s.onerror = () => reject(new Error("Couldn't load the payment window. Check your connection and try again."));
    document.body.appendChild(s);
  });
}

const rupees = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

export default function BillingView({ plans, loadFailed, onRetry, onPlanChanged, onToast }) {
  const [busyPlan, setBusyPlan] = useState(null);
  const [pending, setPending] = useState(false);   // paid, waiting for the server to confirm
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  if (!plans && loadFailed) {
    return (
      <div className="card">
        <div className="notice-bar error" role="alert">
          <span>Couldn't load your plan and pricing. Please check your connection and try again.</span>
          <button className="btn btn-ghost" onClick={onRetry}>Try again</button>
        </div>
      </div>
    );
  }
  if (!plans) {
    return <div className="card" aria-busy="true"><div className="skeleton" style={{ height: 18, width: "30%", marginBottom: 16 }} /><div className="skeleton" style={{ height: 120 }} /></div>;
  }

  const rank = (id) => plans.plans.findIndex((p) => p.id === id);
  const featureLabel = (k) => plans.features[k]?.label || k;
  const expiry = formatExpiry(plans.planExpiresAt);

  // After a payment the server may still be confirming it; look for the plan to change.
  async function waitForActivation(expectedPlan) {
    setPending(true);
    for (let i = 0; i < 15 && alive.current; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const fresh = await onPlanChanged?.();
      if (fresh?.currentPlan === expectedPlan) { setPending(false); onToast?.("Your plan is now active.", "success"); return; }
    }
    if (alive.current) {
      setPending(false);
      onToast?.("Payment received. Your plan will switch on shortly — if it hasn't within a few minutes, contact support with your payment confirmation.", "info");
    }
  }

  async function upgrade(plan) {
    if (busyPlan) return;
    setBusyPlan(plan.id);
    try {
      await loadRazorpay();
      const res = await createCheckout(plan.id);
      if (res.status !== 200 || !res.body?.orderId) {
        const msg = res.body?.error?.message;
        onToast?.(res.status === 501 ? "Online payment isn't switched on yet." : (res.status === 409 || res.status === 400) && msg ? msg : "Couldn't start the payment. Please try again.", "error");
        return;
      }
      const o = res.body;
      await new Promise((resolve) => {
        const rzp = new window.Razorpay({
          key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency,
          name: "MarginPulse", description: `${o.planLabel} plan — 1 month`,
          prefill: { email: o.email }, theme: { color: "#18c496" },
          modal: { ondismiss: () => { onToast?.("Payment cancelled — you haven't been charged.", "info"); resolve(); } },
          handler: async (resp) => {
            const v = await verifyPayment(resp);
            if (v.status === 200 && v.body?.status === "ACTIVE") {
              await onPlanChanged?.();
              onToast?.(`You're now on ${o.planLabel}. Thank you!`, "success");
            } else if (v.status === 202) {
              waitForActivation(plan.id);
            } else {
              const why = v.body?.error?.message || "We couldn't confirm your payment.";
              onToast?.(`${why} If money was taken, your plan will be applied automatically; if it isn't within a few minutes, contact support.`, "error");
            }
            resolve();
          },
        });
        rzp.on("payment.failed", (r) => { onToast?.(`Payment failed: ${r?.error?.description || "please try again"}`, "error"); resolve(); });
        rzp.open();
      });
    } catch (e) {
      onToast?.(e?.message || "Something went wrong starting the payment.", "error");
    } finally {
      if (alive.current) setBusyPlan(null);
    }
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ fontSize: 18 }}>Current plan: {plans.currentPlanLabel}</h3>
          {plans.paymentsEnabled ? <span className="nav-badge badge-pro" style={{ padding: "4px 8px" }}>Secure payment by Razorpay</span> : null}
        </div>
        {expiry && plans.currentPlan !== "FREE" && <p style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 6 }}>Active until {expiry}. Paying again before then adds another month.</p>}
        {pending && <div className="notice-bar" role="status" style={{ marginTop: 12 }}>Payment received — confirming it now…</div>}
        {!plans.paymentsEnabled && <div className="notice-bar" role="status" style={{ marginTop: 12 }}>Online payment isn't switched on yet. Plans and prices are shown below.</div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
        {plans.plans.map((p) => {
          const isCurrent = p.id === plans.currentPlan;
          const included = rank(p.id) < rank(plans.currentPlan);   // a lower plan than the one you have
          const isFree = p.id === "FREE";
          return (
            <div key={p.id} className="card" style={{ marginBottom: 0, border: isCurrent ? "2px solid var(--primary-color)" : undefined }} data-testid={`plan-${p.id}`}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{p.label}{isCurrent ? " · current" : ""}</div>
              <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>{isFree ? "₹0" : p.priceInr != null ? <>{rupees(p.priceInr)}<span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-gray)" }}> /month</span></> : "—"}</div>
              <div style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 12 }}>{p.monthlyCredits.toLocaleString("en-IN")} usage credits / month</div>
              <ul style={{ listStyle: "none", fontSize: 13, lineHeight: 1.9, color: "var(--text-gray)", marginBottom: 16, minHeight: 60 }}>
                {p.features.length === 0 && <li>Core reconciliation</li>}
                {p.features.map((f) => <li key={f}><strong style={{ color: "var(--primary-color)" }}>✓</strong> {featureLabel(f)}</li>)}
              </ul>
              {isFree ? null : isCurrent ? (
                <button className="btn btn-primary" disabled={!p.purchasable || !!busyPlan || pending} onClick={() => upgrade(p)}>{busyPlan === p.id ? "Opening payment…" : "Renew — add a month"}</button>
              ) : included ? (
                <button className="btn btn-ghost" disabled>Included in your plan</button>
              ) : (
                <button className="btn btn-primary" disabled={!p.purchasable || !!busyPlan || pending} onClick={() => upgrade(p)}>
                  {busyPlan === p.id ? "Opening payment…" : p.purchasable ? `Upgrade to ${p.label}` : "Not available yet"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 14 }}>
        Each payment buys one month. Prices in Indian rupees. Payments are processed by Razorpay; MarginPulse never sees your card details.
      </p>
    </div>
  );
}
