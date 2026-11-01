/**
 * Razorpay checkout flow. Every step has a timeout and reports a human message through onStatus, so the
 * Pay button can never sit silent: stage is one of
 *   preparing → awaiting → verifying → success      (or)   idle | error
 * Money safety: the server chooses the price (we only send the plan id), and the payment is confirmed by the
 * server against Razorpay before the plan changes. Verification can be retried without paying again.
 */
import { tokenManager } from '../security/tokenManager';
import { API_BASE, fetchWithTimeout, TIMEOUTS } from '../net';

let scriptPromise = null;

/**
 * Loads checkout.js once. A failed or stalled load is cleaned up so the NEXT click really retries
 * (the old loader re-attached listeners to an element whose events had already fired, so after one
 * failure every later click waited forever).
 */
export function loadRazorpayScript() {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    document.getElementById('razorpay-checkout-script')?.remove();
    const s = document.createElement('script');
    s.id = 'razorpay-checkout-script';
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    let timer;
    const fail = (message, code) => { clearTimeout(timer); s.remove(); scriptPromise = null; const e = new Error(message); e.code = code; reject(e); };
    timer = setTimeout(() => fail('The payment window took too long to load.', 'SCRIPT_TIMEOUT'), TIMEOUTS.script);
    s.onload = () => { clearTimeout(timer); window.Razorpay ? resolve() : fail('The payment window failed to initialise.', 'SCRIPT_INIT'); };
    s.onerror = () => fail('The payment window could not be loaded.', 'SCRIPT_BLOCKED');
    document.body.appendChild(s);
  });
  scriptPromise.catch(() => {}); // avoid an unhandled-rejection warning; callers handle the error
  return scriptPromise;
}

const SCRIPT_HELP = ' Check your internet connection and disable ad/tracker blockers for this site, then try again. You have not been charged.';

function describe(e) {
  if (e?.code === 'TIMEOUT') return 'The payment server took too long to respond. You have not been charged — please try again.';
  if (e?.code?.startsWith?.('SCRIPT')) return e.message + SCRIPT_HELP;
  return "Couldn't reach the payment server. Check your connection and try again. You have not been charged.";
}

let lastPayment = null; // kept in memory only, so a failed confirmation can be retried

async function confirm(response, say) {
  say('verifying', 'Confirming your payment…');
  try {
    const token = await tokenManager.getValidAccessToken();
    const res = await fetchWithTimeout(`${API_BASE}/api/v1/billing/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature }),
    }, TIMEOUTS.verify);
    const data = await res.json().catch(() => ({}));
    if (res.ok) { lastPayment = null; say('success', 'Payment successful — your plan is now active.', { planTier: data.planTier }); return; }
    lastPayment = response;
    say('error', (data?.error || data?.message || 'We could not confirm the payment yet.') + ' If money was deducted it is safe: tap "Retry confirmation", or contact support@marginpulse.in with payment id ' + (response.razorpay_payment_id || '') + '.', { retry: true });
  } catch (e) {
    lastPayment = response;
    say('error', (e?.code === 'TIMEOUT' ? 'Confirmation is taking longer than expected.' : "Couldn't reach the server to confirm.") + ' If money was deducted it is safe: tap "Retry confirmation", or contact support@marginpulse.in with payment id ' + (response.razorpay_payment_id || '') + '.', { retry: true });
  }
}

export function retryVerification({ onStatus = () => {} } = {}) {
  if (!lastPayment) { onStatus({ stage: 'idle', message: 'Nothing to retry.' }); return Promise.resolve(); }
  return confirm(lastPayment, (stage, message, extra) => onStatus({ stage, message, ...extra }));
}

export async function startPayment(planId, { onStatus = () => {} } = {}) {
  const say = (stage, message, extra) => onStatus({ stage, message, ...extra });
  say('preparing', 'Contacting the payment gateway…');
  try {
    const token = await tokenManager.getValidAccessToken();
    if (!token) return say('error', 'Please sign in again before paying.');
    if (!planId) return say('error', 'Please choose a plan.');

    await loadRazorpayScript();

    const orderRes = await fetchWithTimeout(`${API_BASE}/api/v1/billing/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: planId }), // the server decides the price
    }, TIMEOUTS.order);
    const order = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok || !order?.orderId || !order?.keyId) {
      return say('error', orderRes.status === 429 ? 'Too many attempts — please wait a minute and try again.' : (order?.error || order?.message || 'Could not start the payment.') + ' You have not been charged.');
    }

    let email = '';
    try { email = localStorage.getItem('userEmail') || localStorage.getItem('mp_user_email') || ''; } catch { /* storage unavailable */ }

    const rzp = new window.Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      currency: 'INR',
      name: 'MarginPulse',
      description: 'Subscription Payment',
      prefill: { email },
      theme: { color: '#18c496' },
      modal: { ondismiss: () => say('idle', 'Payment window closed — you have not been charged.') },
      handler: (response) => { confirm(response, say); },
    });
    rzp.on('payment.failed', (r) => say('error', `Payment failed: ${r?.error?.description || 'the bank declined it'}. You have not been charged.`));
    rzp.open();
    say('awaiting', 'Complete the payment in the secure window…');
  } catch (e) {
    console.error('[payments] start failed:', e);
    say('error', describe(e));
  }
}
