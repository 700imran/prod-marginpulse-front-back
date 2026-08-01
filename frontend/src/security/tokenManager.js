/**
 * tokenManager.js — Secure token storage and management
 * 
 * Responsibilities:
 * - Store tokens in secure, accessible storage (localStorage for now)
 * - Track token expiry and refresh before expiration
 * - Handle token rotation on server response
 * - Clear tokens on logout (revoke on backend first)
 * - Provide hooks for token state changes
 * 
 * Future enhancements:
 * - Consider httpOnly cookies (requires backend support)
 * - Implement refresh token rotation
 * - Add token encryption at rest
 */

const TOKEN_KEYS = {
  ACCESS: 'mp_access_token',
  REFRESH: 'mp_refresh_token',
  TENANT_ID: 'mp_tenant_id',
  TOKEN_EXPIRES_AT: 'mp_token_expires_at',
};

// Token expiry buffer (refresh 5 minutes before expiry)
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

class TokenManager {
  constructor() {
    this.listeners = [];
    this.refreshTimer = null;
    this.onTokenStateChange = null;
  }

  /**
   * Store tokens from login/register response
   */
  setTokens(accessToken, refreshToken, tenantId, expiresInSeconds = 3600) {
    if (!accessToken || !refreshToken) {
      console.warn('[TokenManager] Invalid tokens provided');
      return false;
    }

    try {
      localStorage.setItem(TOKEN_KEYS.ACCESS, accessToken);
      localStorage.setItem(TOKEN_KEYS.REFRESH, refreshToken);
      localStorage.setItem(TOKEN_KEYS.TENANT_ID, tenantId || '');
      
      // Calculate expiry time (default 1 hour)
      const expiresAt = Date.now() + (expiresInSeconds * 1000);
      localStorage.setItem(TOKEN_KEYS.TOKEN_EXPIRES_AT, expiresAt.toString());
      
      // Start refresh timer
      this.scheduleRefresh(expiresInSeconds);
      
      // Notify listeners
      this.notifyStateChange('LOGIN');
      
      return true;
    } catch (e) {
      console.error('[TokenManager] Failed to store tokens', e);
      return false;
    }
  }

  /**
   * Get current access token
   */
  getAccessToken() {
    try {
      return localStorage.getItem(TOKEN_KEYS.ACCESS) || '';
    } catch {
      return '';
    }
  }

  /**
   * Get refresh token
   */
  getRefreshToken() {
    try {
      return localStorage.getItem(TOKEN_KEYS.REFRESH) || '';
    } catch {
      return '';
    }
  }

  /**
   * Get tenant ID
   */
  getTenantId() {
    try {
      return localStorage.getItem(TOKEN_KEYS.TENANT_ID) || '';
    } catch {
      return '';
    }
  }

  /**
   * Check if user is currently authenticated
   */
  isAuthenticated() {
    return !!this.getAccessToken();
  }

  /**
   * Check if token is expired
   */
  isTokenExpired() {
    try {
      const expiresAt = parseInt(localStorage.getItem(TOKEN_KEYS.TOKEN_EXPIRES_AT) || '0', 10);
      return Date.now() >= expiresAt;
    } catch {
      return true;
    }
  }

  /**
   * Get time until token expiry (milliseconds)
   */
  getTimeUntilExpiry() {
    try {
      const expiresAt = parseInt(localStorage.getItem(TOKEN_KEYS.TOKEN_EXPIRES_AT) || '0', 10);
      return Math.max(0, expiresAt - Date.now());
    } catch {
      return 0;
    }
  }

  /**
   * Schedule token refresh before expiry
   */
  scheduleRefresh(expiresInSeconds) {
    // Clear existing timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    // Schedule refresh at (expiresIn - buffer) time
    const refreshDelay = Math.max(
      1000, // Minimum 1 second
      (expiresInSeconds * 1000) - REFRESH_BUFFER_MS
    );

    this.refreshTimer = setTimeout(() => {
      this.notifyStateChange('REFRESH_NEEDED');
    }, refreshDelay);
  }

  /**
   * Clear all tokens (logout)
   */
  clearTokens() {
    try {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      
      localStorage.removeItem(TOKEN_KEYS.ACCESS);
      localStorage.removeItem(TOKEN_KEYS.REFRESH);
      localStorage.removeItem(TOKEN_KEYS.TENANT_ID);
      localStorage.removeItem(TOKEN_KEYS.TOKEN_EXPIRES_AT);
      
      this.notifyStateChange('LOGOUT');
      return true;
    } catch (e) {
      console.error('[TokenManager] Failed to clear tokens', e);
      return false;
    }
  }

  /**
   * Subscribe to token state changes
   */
  addListener(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  /**
   * Remove listener
   */
  removeListener(callback) {
    this.listeners = this.listeners.filter(l => l !== callback);
  }

  /**
   * Notify all listeners of token state change
   */
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

    // Also call dedicated handler if set
    if (this.onTokenStateChange) {
      try {
        this.onTokenStateChange(event);
      } catch (e) {
        console.error('[TokenManager] Handler error', e);
      }
    }
  }
}

// Export singleton instance
export const tokenManager = new TokenManager();

export default tokenManager;
