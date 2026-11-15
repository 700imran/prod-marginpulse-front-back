import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createWhatsAppLinkCode, getWhatsAppLink, unlinkWhatsApp } from './fallbackApi';

/**
 * "Send invoices by WhatsApp" — links the user's own number to this workspace so files they send to MarginPulse's
 * WhatsApp number land in their account. A number is linked ONLY after its owner sends "LINK <code>" from it
 * (typing a number here would let anyone claim someone else's). Renders nothing unless the server has the WhatsApp
 * gateway switched on.
 */
export default function WhatsAppLinkCard({ pollMs = 5000, onToast }) {
  const [state, setState] = useState(null);        // { gatewayEnabled, gatewayNumber, boundPhone } | null
  const [pending, setPending] = useState(null);    // { message, sendTo, expiresAt }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    const r = await getWhatsAppLink();
    if (r.ok) { setState(r.data); if (r.data?.boundPhone) setPending(null); }
    return r;
  }, []);

  useEffect(() => { refresh(); return () => clearInterval(timer.current); }, [refresh]);

  // While a code is outstanding, check every few seconds whether the number has been linked; stop at expiry.
  useEffect(() => {
    clearInterval(timer.current);
    if (!pending) return undefined;
    timer.current = setInterval(async () => {
      if (Date.now() > pending.expiresAt) { setPending(null); setError('The code expired. Generate a new one.'); return; }
      const r = await refresh();
      if (r.ok && r.data?.boundPhone) onToast?.('WhatsApp number linked', 'success');
    }, pollMs);
    return () => clearInterval(timer.current);
  }, [pending, pollMs, refresh, onToast]);

  if (!state?.gatewayEnabled) return null;

  const generate = async () => {
    setBusy(true); setError('');
    const r = await createWhatsAppLinkCode();
    setBusy(false);
    if (r.ok) setPending({ message: r.data.message, sendTo: r.data.sendTo || state.gatewayNumber, expiresAt: Date.now() + (r.data.expiresInMinutes || 10) * 60000, minutes: r.data.expiresInMinutes });
    else setError(r.status === 429 ? 'Too many attempts — please wait a while and try again.' : (r.data?.error || 'Could not create a link code.'));
  };
  const unlink = async () => {
    setBusy(true); setError('');
    const r = await unlinkWhatsApp();
    setBusy(false);
    if (r.ok) { setState((s) => ({ ...s, boundPhone: null })); onToast?.('WhatsApp number unlinked', 'success'); }
    else setError(r.data?.error || 'Could not unlink right now.');
  };
  const copy = (t) => { try { navigator.clipboard?.writeText(t); } catch { /* clipboard unavailable */ } };

  return (
    <div className="card" style={{ marginBottom: 24 }} data-testid="whatsapp-link">
      <h3 style={{ marginBottom: 6, fontSize: 18 }}>Send invoices by WhatsApp</h3>
      <p style={{ fontSize: 13, color: 'var(--text-gray)', marginBottom: 14 }}>
        Link your number, then send invoice photos or PDFs{state.gatewayNumber ? <> to <strong>{state.gatewayNumber}</strong></> : ''} and they appear in Documents.
      </p>

      {state.boundPhone ? (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}>Linked number: <strong>{state.boundPhone}</strong></span>
          <button type="button" className="btn btn-ghost" onClick={unlink} disabled={busy}>Unlink</button>
        </div>
      ) : pending ? (
        <div role="status" style={{ fontSize: 13, lineHeight: 1.6 }}>
          From the WhatsApp number you want to link, send this exact message{pending.sendTo ? <> to <strong>{pending.sendTo}</strong></> : ''}:
          <div style={{ margin: '8px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{ padding: '6px 10px', background: '#f2f4f7', borderRadius: 8, fontSize: 15 }}>{pending.message}</code>
            <button type="button" className="btn btn-ghost" onClick={() => copy(pending.message)}>Copy</button>
          </div>
          <span style={{ color: 'var(--text-gray)' }}>Valid for {pending.minutes || 10} minutes. This page updates by itself once we receive it.</span>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Preparing…' : 'Link my WhatsApp number'}</button>
      )}
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 13, color: '#b42318' }}>{error}</div>}
    </div>
  );
}
