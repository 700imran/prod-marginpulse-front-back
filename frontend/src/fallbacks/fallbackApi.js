/**
 * fallbackApi.js — the calls behind the "backup" payment (UPI) and WhatsApp-linking screens.
 * Deliberately NOT routed through api.js: that client caches GETs (stale-while-revalidate), which is wrong for
 * payment status and link status where a stale answer means a customer waiting for something that already happened.
 * Every call has a timeout and returns { ok, status, data } — it never throws.
 */
import { tokenManager } from '../security/tokenManager';
import { API_BASE, fetchWithTimeout } from '../net';

async function call(method, path, body, ms = 20000) {
  try {
    const token = await tokenManager.getValidAccessToken();
    if (!token) return { ok: false, status: 401, data: { error: 'Please sign in again.' } };
    const res = await fetchWithTimeout(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, ms);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e?.code === 'TIMEOUT' ? 'The server took too long to respond.' : "Couldn't reach the server. Check your connection." }, network: true };
  }
}

// UPI backup payment (Razorpay alternative). The server chooses the price; we only send the plan id.
export const getUpiConfig = () => call('GET', '/api/v1/billing/upi/config', undefined, 10000);
export const createUpiOrder = (plan) => call('POST', '/api/v1/billing/upi/orders', { plan });
export const submitUpiUtr = (paymentId, utr) => call('POST', `/api/v1/billing/upi/orders/${encodeURIComponent(paymentId)}/utr`, { utr });
export const getUpiOrder = (paymentId) => call('GET', `/api/v1/billing/upi/orders/${encodeURIComponent(paymentId)}`, undefined, 15000);

// WhatsApp number linking (proof of ownership: the user sends "LINK <code>" from the number to link).
export const getWhatsAppLink = () => call('GET', '/api/v1/settings/whatsapp', undefined, 10000);
export const createWhatsAppLinkCode = () => call('POST', '/api/v1/settings/whatsapp/link-code');
export const unlinkWhatsApp = () => call('DELETE', '/api/v1/settings/whatsapp');
