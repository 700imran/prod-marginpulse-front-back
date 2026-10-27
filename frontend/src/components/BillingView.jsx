/**
 * BillingView.jsx — Payment entry point for the app.
 *
 * Uses Razorpay checkout to create a backend order and verify it after
 * successful payment. This is intentionally kept in the dedicated Billing
 * page rather than spreading checkout logic across the app shell.
 */
import { useState } from "react";
import { tokenManager } from "../security/tokenManager";

const API_BASE = "https://api.marginpulse.in";
const PLAN_OPTIONS = [
  { id: "starter", label: "Starter", price: 499, description: "For solo practitioners" },
  { id: "pro", label: "Pro", price: 1499, description: "Best for growing teams" },
  { id: "enterprise", label: "Enterprise", price: 4999, description: "Advanced controls & scale" },
];

function getAccessToken() {
  return tokenManager.getAccessToken() || "";
}

async function loadRazorpayScript() {
  if (window.Razorpay) return;

  await new Promise((resolve, reject) => {
    const existing = document.getElementById("razorpay-checkout-script");
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Razorpay script.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = "razorpay-checkout-script";
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load Razorpay script."));
    document.body.appendChild(script);
  });
}

export async function startPayment(planId) {
  const token = getAccessToken();

  if (!token) {
    alert("Please log in before starting a payment.");
    return;
  }

  if (!planId) {
    alert("Please choose a plan.");
    return;
  }

  try {
    await loadRazorpayScript();

    const orderRes = await fetch(`${API_BASE}/api/v1/billing/create-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan: planId }), // the server decides the price
    });

    const orderData = await orderRes.json().catch(() => ({}));

    if (!orderRes.ok || !orderData?.orderId || !orderData?.keyId) {
      throw new Error(orderData?.error || orderData?.message || "Failed to create payment order.");
    }

    const userEmail = localStorage.getItem("userEmail") || localStorage.getItem("mp_user_email") || "";

    const rzp = new window.Razorpay({
      key: orderData.keyId,
      order_id: orderData.orderId,
      currency: "INR",
      name: "MarginPulse",
      description: "Subscription Payment",
      handler: async function (response) {
        const verifyRes = await fetch(`${API_BASE}/api/v1/billing/verify-payment`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          }),
        });

        const verifyData = await verifyRes.json().catch(() => ({}));

        if (verifyRes.ok) {
          alert("Payment successful! Your plan is now active.");
          try { sessionStorage.removeItem("mp_profile"); } catch { /* ignore */ }
          window.location.reload(); // pick up the upgraded plan
          return;
        }

        alert(verifyData?.error || verifyData?.message || "Payment verification failed — if money was deducted, contact support@marginpulse.in with your payment id.");
      },
      prefill: {
        email: userEmail,
      },
      theme: { color: "#18c496" },
    });

    rzp.on("payment.failed", function (response) {
      alert(`Payment failed: ${response?.error?.description || "Unknown error"}`);
    });

    rzp.open();
  } catch (error) {
    console.error("[BillingView] Payment failed:", error);
    alert(error?.message || "Something went wrong while starting the payment.");
  }
}

export default function BillingView({ tenant }) {
  const [isPaying, setIsPaying] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("pro");
  const planLabel = tenant?.planTier === "FREE" ? "Auditor Free" : tenant?.planTier || "Auditor Free";
  const selectedPlan = PLAN_OPTIONS.find((plan) => plan.id === selectedPlanId) || PLAN_OPTIONS[1];

  const handleUpgrade = async () => {
    setIsPaying(true);
    try {
      await startPayment(selectedPlan.id);
    } finally {
      setIsPaying(false);
    }
  };

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
        disabled={isPaying}
        style={{ opacity: isPaying ? 0.7 : 1 }}
      >
        {isPaying ? "Processing payment..." : `Upgrade to ${selectedPlan.label} — ₹${selectedPlan.price}`}
      </button>

      <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 14 }}>
        Payment is processed through Razorpay via the MarginPulse billing API at <strong>https://api.marginpulse.in</strong>.
      </p>
    </div>
  );
}
