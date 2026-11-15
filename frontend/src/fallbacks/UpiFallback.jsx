import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createUpiOrder, getUpiConfig, getUpiOrder, submitUpiUtr } from './fallbackApi';

/**
 * "Pay via UPI (backup)" — shown only when the server has the UPI fallback switched on (GET /billing/upi/config).
 *   manual  : pay to our UPI ID, type the 12-digit UTR, we confirm the credit and activate the plan.
 *   gateway : pay on the gateway's page / UPI app; the plan activates automatically (we poll the order).
 * Prices are display-only; the server decides the amount. Opens by itself when the card payment just failed.
 */
const FINAL = new Set(['PAID', 'REJECTED', 'EXPIRED']);
const box = { marginTop: 18, padding: 14, borderRadius: 12, border: '1px solid var(--border-color, #e5e0d6)', background: '#fafaf8' };
const note = (tone) => ({ marginTop: 10, padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5, background: tone === 'error' ? '#fdecea' : tone === 'ok' ? '#eafbf5' : '#f2f4f7', color: tone === 'error' ? '#b42318' : tone === 'ok' ? '#0f6e56' : '#344054' });

export default function UpiFallback({ plan, onPaid, forceOpen = false, pollMs }) {
  const [config, setConfig] = useState(null);       // null = still asking / not available
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [utr, setUtr] = useState('');
  const [msg, setMsg] = useState(null);             // { tone, text }
  const [open, setOpen] = useState(false);
  const paidOnce = useRef(false);

  useEffect(() => {
    let alive = true;
    getUpiConfig().then((r) => { if (alive && r.ok && r.data?.enabled) setConfig(r.data); });
    return () => { alive = false; };
  }, []);

  const status = order?.status;
  const settle = useCallback((o) => {
    setOrder(o);
    if (o.status === 'PAID' && !paidOnce.current) { paidOnce.current = true; setMsg({ tone: 'ok', text: 'UPI payment confirmed — your plan is now active.' }); onPaid?.(); }
    if (o.status === 'REJECTED') setMsg({ tone: 'error', text: 'We could not match this payment to our bank credit, so it was not applied. If money was debited, it will be refunded — contact support@marginpulse.in with your reference.' });
    if (o.status === 'EXPIRED') setMsg({ tone: 'error', text: 'This UPI payment request expired. You have not been charged by us — start a new one if you still want to upgrade.' });
  }, [onPaid]);

  // Poll while a payment is waiting on us / the gateway. Gateway orders are checked fast; manual ones slowly.
  useEffect(() => {
    if (!order?.paymentId || FINAL.has(status)) return undefined;
    if (order.mode === 'manual' && status !== 'SUBMITTED') return undefined; // nothing to wait for until the UTR is sent
    const every = pollMs ?? (order.mode === 'gateway' ? 4000 : 30000);
    const t = setInterval(async () => { const r = await getUpiOrder(order.paymentId); if (r.ok && r.data?.status) settle({ ...order, ...r.data }); }, every);
    return () => clearInterval(t);
  }, [order, status, settle, pollMs]);

  if (!config) return null;

  const start = async () => {
    setBusy(true); setMsg(null);
    const r = await createUpiOrder(plan.id);
    setBusy(false);
    if (r.ok) { setOrder(r.data); return; }
    setMsg({ tone: 'error', text: r.status === 429 ? (r.data?.error || 'Too many attempts — please wait and try again.') : `${r.data?.error || 'Could not start a UPI payment.'}` });
  };
  const sendUtr = async () => {
    setBusy(true); setMsg(null);
    const r = await submitUpiUtr(order.paymentId, utr.trim());
    setBusy(false);
    if (r.ok) { setOrder({ ...order, status: 'SUBMITTED' }); setMsg({ tone: 'ok', text: r.data?.message || 'Thanks — we will confirm the credit and activate your plan.' }); }
    else setMsg({ tone: 'error', text: r.data?.error || 'Could not save the UTR. Please try again.' });
  };
  const copy = (text) => { try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ } };

  const expanded = open || forceOpen || Boolean(order);
  return (
    <div style={box} data-testid="upi-fallback">
      {!expanded ? (
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>Pay via UPI (backup)</button>
      ) : (
        <>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Pay via UPI (backup)</div>
          <p style={{ fontSize: 12, color: 'var(--text-gray, #6b6b6b)', margin: '0 0 10px' }}>
            Card/net-banking not working? Pay <strong>₹{plan.price}</strong> for {plan.label} with any UPI app.
            {config.mode === 'manual' ? ' We confirm the bank credit by hand, usually within a few working hours.' : ' Your plan activates automatically after payment.'}
          </p>

          {!order && <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>{busy ? 'Preparing…' : `Pay ₹${plan.price} via UPI`}</button>}

          {order && order.mode === 'manual' && status === 'PENDING' && (
            <div>
              <ol style={{ fontSize: 13, lineHeight: 1.7, paddingLeft: 18, margin: '0 0 10px' }}>
                <li>Pay exactly <strong>₹{order.amountInr}</strong> to <strong>{order.vpa}</strong> ({order.payeeName}) — put <code>{order.reference}</code> in the note.</li>
                <li>Copy the 12-digit <strong>UTR / UPI reference</strong> shown after the payment and enter it below.</li>
              </ol>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                {order.upiIntent && <a className="btn btn-primary" href={order.upiIntent}>Open UPI app</a>}
                <button type="button" className="btn btn-ghost" onClick={() => copy(order.vpa)}>Copy UPI ID</button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input className="form-control" aria-label="12-digit UTR" inputMode="numeric" maxLength={12} placeholder="12-digit UTR" value={utr} onChange={(e) => setUtr(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 220 }} />
                <button type="button" className="btn btn-primary" onClick={sendUtr} disabled={busy || utr.length !== 12}>{busy ? 'Saving…' : 'Submit UTR'}</button>
              </div>
            </div>
          )}

          {order && order.mode === 'manual' && status === 'SUBMITTED' && <div style={note('info')} role="status">UTR received. We are checking our bank credit — you can close this page; your plan activates once it is confirmed.</div>}

          {order && order.mode === 'gateway' && status === 'PENDING' && (
            <div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {order.paymentUrl && <a className="btn btn-primary" href={order.paymentUrl} target="_blank" rel="noopener noreferrer">Open payment page</a>}
                {order.upiIntent && <a className="btn btn-ghost" href={order.upiIntent}>Open UPI app</a>}
              </div>
              <div style={note('info')} role="status"><span className="mp-auth-spinner" aria-hidden="true" style={{ display: 'inline-block', marginRight: 8 }}></span>Waiting for your payment… this page updates by itself.</div>
            </div>
          )}

          {msg && <div style={note(msg.tone)} role={msg.tone === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
          {order && FINAL.has(status) && status !== 'PAID' && <div style={{ marginTop: 10 }}><button type="button" className="btn btn-ghost" onClick={() => { setOrder(null); setMsg(null); setUtr(''); }}>Start a new UPI payment</button></div>}
        </>
      )}
    </div>
  );
}
