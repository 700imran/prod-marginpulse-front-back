/**
 * apiClient.js — Secure API client layer
 * 
 * Responsibilities:
 * - Attach auth tokens to requests
 * - Handle response errors safely
 * - Classify errors for appropriate user messaging
 * - Never expose backend details to user
 * - Coordinate with token manager
 */

import {
  createSafeError,
  sanitizeErrorMessage,
  logErrorSecurely,
  classifyHttpError,
  ERROR_MESSAGES,
} from './errorHandler';
import { tokenManager } from './tokenManager';

const BASE_URL = process.env.REACT_APP_API_URL || '';

class ApiClient {
  constructor() {
    this.abortControllers = new Map();
  }

  /**
   * Get auth headers with current token
   */
  getAuthHeaders() {
    const token = tokenManager.getAccessToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * Main request method
   * Handles errors, token refresh, and response parsing
   */
  async request(method, endpoint, body = null, options = {}) {
    const { 
      timeout = 30000,
      retryOnAuth = true,
      signal = null,
    } = options;

    const url = `${BASE_URL}${endpoint}`;
    const abortController = new AbortController();
    const requestId = `${method}:${endpoint}:${Date.now()}`;

    // Store abort controller for potential cancellation
    this.abortControllers.set(requestId, abortController);

    try {
      // Set timeout
      const timeoutId = setTimeout(() => abortController.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: this.getAuthHeaders(),
        ...(body && { body: JSON.stringify(body) }),
        signal: signal || abortController.signal,
      });

      clearTimeout(timeoutId);

      // Handle auth errors with token refresh
      if (response.status === 401 && retryOnAuth) {
        const refreshed = await this.refreshTokens();
        if (refreshed) {
          // Retry original request with new token
          return this.request(method, endpoint, body, { ...options, retryOnAuth: false });
        } else {
          // Refresh failed - redirect to login
          tokenManager.clearTokens();
          window.location.href = '/';
          return this.createErrorResponse('SESSION_EXPIRED', 'AUTH_ERROR');
        }
      }

      // Parse response
      const data = await this.parseResponse(response);

      // If response status is error but parseable (e.g., 400 validation)
      if (!response.ok) {
        return this.handleErrorResponse(response.status, data);
      }

      return { success: true, data };

    } catch (error) {
      return this.handleFetchError(error);
    } finally {
      this.abortControllers.delete(requestId);
    }
  }

  /**
   * Parse response body safely
   */
  async parseResponse(response) {
    try {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      return null;
    } catch (e) {
      console.error('[ApiClient] Failed to parse response', e);
      return null;
    }
  }

  /**
   * Handle HTTP error responses
   * Classify and create safe error for user
   */
  handleErrorResponse(status, data) {
    const errorType = classifyHttpError(status, data);
    
    let details = {};
    let userMessage = ERROR_MESSAGES.GENERIC_ERROR;

    // Extract error details from response (if backend provided them)
    if (data?.detail) {
      // Be careful: some error details might leak backend info
      // Let backend control what's exposed
      const detail = String(data.detail).toLowerCase();
      
      if (detail.includes('invalid')) {
        details.reason = 'invalid_credentials';
        userMessage = ERROR_MESSAGES.AUTH_INVALID_CREDENTIALS;
      } else if (detail.includes('locked')) {
        details.reason = 'locked';
        userMessage = ERROR_MESSAGES.AUTH_ACCOUNT_LOCKED;
      } else if (detail.includes('email')) {
        details.field = 'email';
        userMessage = ERROR_MESSAGES.VALIDATION_EMAIL;
      } else if (detail.includes('password')) {
        details.field = 'password';
        userMessage = ERROR_MESSAGES.VALIDATION_PASSWORD;
      } else if (status >= 500) {
        userMessage = ERROR_MESSAGES.SERVER_ERROR;
      }
    } else if (status >= 500) {
      userMessage = ERROR_MESSAGES.SERVER_ERROR;
    }

    const safeError = createSafeError(
      new Error(userMessage),
      errorType,
      {
        httpStatus: status,
        ...details,
      }
    );

    logErrorSecurely(safeError, tokenManager.getTenantId());

    return {
      success: false,
      error: safeError,
      userMessage,
    };
  }

  /**
   * Handle network/fetch errors
   */
  handleFetchError(error) {
    // Abort is expected when timeout occurs
    if (error.name === 'AbortError') {
      const safeError = createSafeError(
        error,
        'NETWORK_ERROR',
        { reason: 'timeout' }
      );
      return {
        success: false,
        error: safeError,
        userMessage: ERROR_MESSAGES.NETWORK_ERROR,
      };
    }

    // Network failure
    const safeError = createSafeError(error, 'NETWORK_ERROR');
    logErrorSecurely(safeError, tokenManager.getTenantId());

    return {
      success: false,
      error: safeError,
      userMessage: ERROR_MESSAGES.NETWORK_ERROR,
    };
  }

  /**
   * Utility to create error response
   */
  createErrorResponse(message, errorType) {
    const safeError = createSafeError(new Error(message), errorType);
    return {
      success: false,
      error: safeError,
      userMessage: ERROR_MESSAGES.GENERIC_ERROR,
    };
  }

  /**
   * Refresh tokens
   */
  async refreshTokens() {
    try {
      const refreshToken = tokenManager.getRefreshToken();
      if (!refreshToken) return false;

      const response = await fetch(`${BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) return false;

      const data = await response.json();
      if (data?.access_token && data?.refresh_token) {
        tokenManager.setTokens(
          data.access_token,
          data.refresh_token,
          data.tenant_id,
          data.expires_in || 3600
        );
        return true;
      }

      return false;
    } catch (e) {
      console.error('[ApiClient] Token refresh failed', e);
      return false;
    }
  }

  /**
   * Cancel pending request
   */
  cancelRequest(requestId) {
    const controller = this.abortControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(requestId);
    }
  }

  /**
   * GET request
   */
  async get(endpoint, options = {}) {
    return this.request('GET', endpoint, null, options);
  }

  /**
   * POST request
   */
  async post(endpoint, body, options = {}) {
    return this.request('POST', endpoint, body, options);
  }

  /**
   * PATCH request
   */
  async patch(endpoint, body, options = {}) {
    return this.request('PATCH', endpoint, body, options);
  }

  /**
   * DELETE request
   */
  async delete(endpoint, options = {}) {
    return this.request('DELETE', endpoint, null, options);
  }
}

// Export singleton
export const apiClient = new ApiClient();

export default apiClient;
