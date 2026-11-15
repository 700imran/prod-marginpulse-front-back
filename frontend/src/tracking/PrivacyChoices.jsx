import React, { useEffect, useState } from 'react';
import { CONSENT_EVENT, eraseMyVisits, getConsent, privacySignalOn, setConsent } from './visitorTracking';

/** Small card for the Profile screen: see the current analytics choice, change it, or erase what was stored. */
export default function PrivacyChoices() {
  const [consent, setLocal] = useState(() => getConsent());
  const [note, setNote] = useState('');
  useEffect(() => {
    const onChange = () => setLocal(getConsent());
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, []);

  const signal = privacySignalOn();
  const choose = async (granted) => {
    const r = await setConsent(granted);
    setNote(granted ? 'Thanks — visit counting is on.' : r === 'erased' || r === 'nothing_to_erase' ? 'Visit counting is off and your stored visits were erased.' : 'Visit counting is off. We could not reach the server to erase old visits right now; they are deleted automatically after 90 days.');
  };
  const erase = async () => {
    const r = await eraseMyVisits();
    setNote(r === 'erased' || r === 'nothing_to_erase' ? 'Your stored visits were erased.' : 'Could not reach the server right now — please try again later.');
  };

  return (
    <div className="card" style={{ padding: 16, marginTop: 16 }}>
      <h3 style={{ fontSize: 15, marginBottom: 6 }}>Privacy choices</h3>
      <p style={{ fontSize: 13, color: 'var(--text-gray, #6b6b6b)', marginBottom: 10 }}>
        Visit counting: <strong>{signal ? 'off (your browser sends a Do-Not-Track / Global Privacy Control signal)' : consent === 'granted' ? 'on' : 'off'}</strong>.
        We never join it to your account, name, email or documents.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!signal && consent !== 'granted' && <button type="button" className="btn btn-ghost" onClick={() => choose(true)}>Turn on</button>}
        {!signal && consent === 'granted' && <button type="button" className="btn btn-ghost" onClick={() => choose(false)}>Turn off &amp; erase</button>}
        <button type="button" className="btn btn-ghost" onClick={erase}>Erase my stored visits</button>
      </div>
      {note && <p role="status" style={{ fontSize: 12, marginTop: 8 }}>{note}</p>}
    </div>
  );
}
