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

class TokenManager {
  constructor() {
    this.listeners = [];
    this.onTokenStateChange = null;
    this.currentSession = null;

    // Seed the cache immediately (supabase-js reads its persisted
    // session from localStorage synchronously internally, but only
    // exposes it via this async call), then keep it in sync.
    supabase.auth.getSession().then(({ data }) => {
      this.currentSession = data?.session ?? null;
    });
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
