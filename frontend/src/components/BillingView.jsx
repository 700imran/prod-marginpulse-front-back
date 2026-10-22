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

function getAccessToken() {
  return (
    tokenManager.getAccessToken() ||
    localStorage.getItem("mp_access_token") ||
    localStorage.getItem("token") ||
    ""
  );
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

export async function startPayment(amount) {
  const finalAmount = Number(amount || 0);
  const token = getAccessToken();

  if (!token) {
    alert("Please log in before starting a payment.");
    return;
  }

  if (!finalAmount || finalAmount <= 0) {
    alert("Please enter a valid amount.");
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
      body: JSON.stringify({ amount: finalAmount, currency: "INR" }),
    });

    const orderData = await orderRes.json().catch(() => ({}));

    if (!orderRes.ok || !orderData?.orderId || !orderData?.keyId) {
      throw new Error(orderData?.message || "Failed to create payment order.");
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
          alert("Payment successful!");
          return;
        }

        throw new Error(verifyData?.message || "Payment verification failed.");
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
  const planLabel = tenant?.planTier === "FREE" ? "Auditor Free" : tenant?.planTier || "Auditor Free";
  const amount = 1499;

  const handleUpgrade = async () => {
    setIsPaying(true);
    try {
      await startPayment(amount);
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
        {isPaying ? "Processing payment..." : `Upgrade to Pro — ₹${amount}`}
      </button>

      <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 14 }}>
        Payment is processed through Razorpay via the MarginPulse billing API at <strong>https://api.marginpulse.in</strong>.
      </p>
    </div>
  );
}
