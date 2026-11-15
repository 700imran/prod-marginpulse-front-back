import React, { useEffect, useState } from 'react';
import { CONSENT_EVENT, getConsent, privacySignalOn, setConsent, trackVisit } from './visitorTracking';

/**
 * Bottom banner shown until the person decides. Counts the visit once when consent was already granted on an
 * earlier day. Hidden entirely when the browser sends Do-Not-Track / Global Privacy Control (nothing to ask).
 */
export default function ConsentBanner() {
  const [decision, setDecision] = useState(() => getConsent());

  useEffect(() => {
    trackVisit();
    const onChange = () => setDecision(getConsent());
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, []);

  if (decision !== null || privacySignalOn()) return null;
  return (
    <div role="region" aria-label="Analytics consent" className="mp-consent"
      style={{ position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 9999, maxWidth: 640, margin: '0 auto', background: '#fff', border: '1px solid var(--border-color, #e5e0d6)', borderRadius: 14, boxShadow: '0 8px 30px rgba(0,0,0,.12)', padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <p style={{ flex: '1 1 280px', fontSize: 13, lineHeight: 1.45, color: 'var(--text-dark, #333)' }}>
        May we count your visit to improve MarginPulse? We store a random ID in your browser (no cookie, no name, email or documents) and your approximate city. You can change this any time under Profile → Privacy choices.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => setConsent(false)} style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border-color, #e5e0d6)', background: '#fff', cursor: 'pointer', fontSize: 13 }}>No thanks</button>
        <button type="button" onClick={() => setConsent(true)} style={{ padding: '8px 14px', borderRadius: 10, border: 0, background: 'var(--primary-color, #18c496)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Accept</button>
      </div>
    </div>
  );
}
