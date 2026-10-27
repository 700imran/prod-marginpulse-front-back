/**
 * tokenManager.js — thin wrapper around the Supabase Auth session.
 *
 * This used to manage raw JWTs in localStorage itself, issued by this
 * app's own /auth/login, /auth/register, /auth/refresh endpoints.
 * Those endpoints don't exist on the Cloudflare backend — auth is
 * Supabase's job end to end now (see
 * backend-cloudflare/src/auth/supabase.ts). supabase-js already
 * persists and auto-refreshes the session in its own localStorage key,
 * so this module just keeps an in-memory mirror of the current
 * session (kept in sync via onAuthStateChange) so the rest of the app
 * — which calls getAccessToken() synchronously in a lot of places —
 * doesn't need to become async everywhere.
 *
 * "Tenant ID" is the Supabase user's UUID (auth.users.id) — see the
 * comment in backend-cloudflare/src/auth/supabase.ts confirming that's
 * intentional, not a placeholder.
 */
import { supabase } from '../supabaseClient';

// supabase-js persists the session in localStorage under sb-<project-ref>-auth-token
// but only exposes it through an ASYNC call. Reading the same key synchronously
// means the token (and the user's name) exist from the very first render, so the
// first API calls after a page refresh carry a valid token instead of going out
// anonymous, bouncing off a 401 and paying for a Supabase refresh round trip.
function readPersistedSession() {
  try {
    const ref = new URL(process.env.REACT_APP_SUPABASE_URL || '').hostname.split('.')[0];
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    const s = raw ? JSON.parse(raw) : null;
    return s?.access_token ? s : null;
  } catch {
    return null;
  }
}

class TokenManager {
  constructor() {
    this.listeners = [];
    this.onTokenStateChange = null;
    this.currentSession = readPersistedSession();

    // Reconcile with supabase-js (this is also what refreshes an expired token).
    this.ready = supabase.auth.getSession().then(({ data }) => {
      this.currentSession = data?.session ?? this.currentSession;
    }).catch(() => {});
    supabase.auth.onAuthStateChange((event, session) => {
      this.currentSession = session;
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') this.notifyStateChange('LOGIN');
      else if (event === 'SIGNED_OUT') this.notifyStateChange('LOGOUT');
    });
  }

  /**
   * Kept only so LoginPage.jsx's existing call sites don't need to
   * change shape. supabase-js already persisted the session itself by
   * the time signInWithPassword()/signUp() resolves; this just isn't
   * needed for anything anymore.
   */
  setTokens() {
    return true;
  }

  getAccessToken() {
    return this.currentSession?.access_token || '';
  }

  /**
   * A token that is valid RIGHT NOW. Returns synchronously-available tokens
   * immediately; only waits (for supabase-js to refresh) when the stored one
   * is missing or about to expire — never sends a doomed request.
   */
  async getValidAccessToken() {
    const exp = this.currentSession?.expires_at;
    if (this.currentSession?.access_token && exp && exp * 1000 - Date.now() > 10000) {
      return this.currentSession.access_token;
    }
    await this.ready;
    try {
      const { data } = await supabase.auth.getSession(); // refreshes if expired
      this.currentSession = data?.session ?? this.currentSession;
    } catch { /* fall through with whatever we have */ }
    return this.currentSession?.access_token || '';
  }

  /** Best available human label before the API answers (display only, never trusted). */
  getUserLabel() {
    const u = this.currentSession?.user;
    const m = u?.user_metadata || {};
    return m.full_name || m.name || m.business_name || (u?.email ? u.email.split('@')[0] : '');
  }

  getRefreshToken() {
    return this.currentSession?.refresh_token || '';
  }

  getTenantId() {
    return this.currentSession?.user?.id || '';
  }

  isAuthenticated() {
    return !!this.getAccessToken();
  }

  isTokenExpired() {
    const expiresAt = this.currentSession?.expires_at; // seconds since epoch (supabase-js convention)
    if (!expiresAt) return true;
    return Date.now() >= expiresAt * 1000;
  }

  getTimeUntilExpiry() {
    const expiresAt = this.currentSession?.expires_at;
    if (!expiresAt) return 0;
    return Math.max(0, expiresAt * 1000 - Date.now());
  }

  /**
   * Clears local state immediately (synchronously, same as the old
   * behavior) and fires supabase.auth.signOut() in the background to
   * actually invalidate the session server-side. Not awaited on
   * purpose — callers here never awaited the old version either, and
   * the UI should look logged-out instantly rather than waiting on a
   * network round trip.
   */
  clearTokens() {
    this.currentSession = null;
    this.notifyStateChange('LOGOUT');
    supabase.auth.signOut().catch((e) => console.error('[TokenManager] supabase signOut failed', e));
    return true;
  }

  addListener(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  removeListener(callback) {
    this.listeners = this.listeners.filter(l => l !== callback);
  }

  notifyStateChange(event) {
    this.listeners.forEach(callback => {
      try {
        callback({
          event,
          isAuthenticated: this.isAuthenticated(),
          timeUntilExpiry: this.getTimeUntilExpiry(),
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[TokenManager] Listener error', e);
      }
    });

    if (this.onTokenStateChange) {
      try {
        this.onTokenStateChange(event);
      } catch (e) {
        console.error('[TokenManager] Handler error', e);
      }
    }
  }
}

export const tokenManager = new TokenManager();

export default tokenManager;
