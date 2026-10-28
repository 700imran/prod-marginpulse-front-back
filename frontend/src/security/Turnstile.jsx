/**
 * Turnstile.jsx — Cloudflare Turnstile captcha for the frontend.
 *
 * The site key comes from the BACKEND (GET /api/v1/config/public), so enabling/disabling the captcha
 * or rotating the key is a Worker config change, not a frontend redeploy. The widget produces a
 * single-use token; the token is verified server-side — by Supabase Auth for sign-in / sign-up
 * (Supabase dashboard → Authentication → Attack Protection → CAPTCHA → Turnstile), and by our
 * Worker for the public API routes (X-Turnstile-Token header).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getPublicConfig } from '../api';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function loadScript() {
  if (typeof window !== 'undefined' && window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptPromise = null; reject(new Error('turnstile script failed to load')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export const Turnstile = forwardRef(function Turnstile({ siteKey, action, onToken, onError, theme = 'auto' }, ref) {
  const el = useRef(null);
  const widgetId = useRef(null);
  const tokenCb = useRef(onToken);
  const errorCb = useRef(onError);
  tokenCb.current = onToken;
  errorCb.current = onError;

  useImperativeHandle(ref, () => ({
    // Tokens are single-use: call after every failed attempt to get a fresh one.
    reset() {
      tokenCb.current?.('');
      try { if (window.turnstile && widgetId.current !== null) window.turnstile.reset(widgetId.current); } catch { /* widget gone */ }
    },
  }));

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !el.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(el.current, {
          sitekey: siteKey,
          action,
          theme,
          callback: (t) => tokenCb.current?.(t),
          'expired-callback': () => tokenCb.current?.(''),
          'error-callback': () => { tokenCb.current?.(''); errorCb.current?.(); },
        });
      })
      .catch(() => { tokenCb.current?.(''); errorCb.current?.(); });
    return () => {
      cancelled = true;
      try { if (window.turnstile && widgetId.current !== null) window.turnstile.remove(widgetId.current); } catch { /* ignore */ }
      widgetId.current = null;
    };
  }, [siteKey, action, theme]);

  return <div ref={el} data-testid="turnstile-widget" style={{ minHeight: 65, margin: '8px 0' }} />;
});

/**
 * State for one protected form.
 *   pending  — still asking the backend whether captcha is on (keep the submit button disabled)
 *   required — captcha is on and no valid token yet
 */
export function useCaptcha(action) {
  const [cfg, setCfg] = useState(null);
  const [token, setToken] = useState('');
  const [failed, setFailed] = useState(false);
  const widget = useRef(null);

  useEffect(() => {
    let alive = true;
    getPublicConfig().then((c) => { if (alive) setCfg(c?.captcha ?? { enabled: false }); });
    return () => { alive = false; };
  }, []);

  const enabled = !!cfg?.enabled && !!cfg?.siteKey;
  return {
    pending: cfg === null,
    enabled,
    siteKey: cfg?.siteKey ?? null,
    action,
    token,
    failed,
    required: enabled && !token,
    setToken,
    setFailed,
    widget,
    reset: useCallback(() => widget.current?.reset(), []),
  };
}

/** Renders the widget (or nothing when captcha is off). */
export function CaptchaField({ captcha }) {
  if (!captcha.enabled) return null;
  return (
    <div>
      <Turnstile ref={captcha.widget} siteKey={captcha.siteKey} action={captcha.action} onToken={(t) => { captcha.setToken(t); if (t) captcha.setFailed(false); }} onError={() => captcha.setFailed(true)} />
      {captcha.failed && (
        <p className="mp-auth-helper-text" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>
          The security check couldn't load. Disable ad/tracker blockers for this site or refresh, then try again.
        </p>
      )}
    </div>
  );
}
