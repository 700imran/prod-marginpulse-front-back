/**
 * errorHandler.js — Security-first error handler
 * 
 * Guidelines:
 * - Never expose backend internals (stack traces, endpoint details, server states)
 * - Log detailed errors server-side, show generic user-friendly messages client-side
 * - Sanitize all error messages before display
 * - Track security events without exposing sensitive data
 * 
 * Error Classification:
 * - AUTH_ERROR: authentication/authorization failures
 * - VALIDATION_ERROR: input validation failures
 * - NETWORK_ERROR: network connectivity issues
 * - SERVER_ERROR: backend failures (always show generic message)
 * - UNKNOWN_ERROR: unexpected errors
 */

export const ERROR_MESSAGES = {
  // Generic, user-safe messages
  GENERIC_ERROR: 'Something went wrong. Please try again.',
  SERVER_ERROR: 'We encountered an issue. Please try again later.',
  NETWORK_ERROR: 'Network connection failed. Please check your internet and try again.',
  
  // Auth-specific
  AUTH_INVALID_CREDENTIALS: 'Invalid email or password.',
  AUTH_ACCOUNT_LOCKED: 'Too many failed attempts. Please try again later.',
  AUTH_SESSION_EXPIRED: 'Your session has expired. Please log in again.',
  AUTH_INVALID_TOKEN: 'Invalid session. Please log in again.',
  
  // Validation-specific
  VALIDATION_EMAIL: 'Please enter a valid email address.',
  VALIDATION_PASSWORD: 'Password must be at least 8 characters.',
  VALIDATION_PASSWORD_MISMATCH: 'Passwords do not match.',
  VALIDATION_REQUIRED_FIELD: 'This field is required.',
  VALIDATION_BUSINESS_NAME: 'Please enter a valid business name.',
  
  // Form submission
  FORM_SUBMISSION_FAILED: 'Could not submit the form. Please try again.',
  FORM_TOO_MANY_ATTEMPTS: 'Too many attempts. Please wait before trying again.',
};

/**
 * Error severity levels for internal logging (never shown to user)
 */
export const ERROR_SEVERITY = {
  LOW: 'low',      // User error, expected
  MEDIUM: 'medium', // System error, needs attention
  HIGH: 'high',    // Security issue, critical
};

/**
 * Sanitize error message: remove backend details, stack traces, internal paths
 */
export function sanitizeErrorMessage(error) {
  if (!error) return ERROR_MESSAGES.GENERIC_ERROR;
  
  const message = String(error.message || error).toLowerCase();
  
  // Don't expose backend internals
  const dangerousPatterns = [
    /stack\s*trace/i,
    /at\s+\w+\s*\(/,
    /\.py:|\.js:|\.java:/,
    /database|connection|sql|query/i,
    /server|backend|internal|system/i,
    /config|secret|key|token/i,
  ];
  
  if (dangerousPatterns.some(pattern => pattern.test(message))) {
    return ERROR_MESSAGES.SERVER_ERROR;
  }
  
  return message;
}

/**
 * Create a safe error object for frontend use
 * - Strips sensitive data
 * - Assigns user-safe message
 * - Preserves error classification for analytics
 */
export function createSafeError(error, type = 'UNKNOWN_ERROR', details = {}) {
  const errorId = generateErrorId();
  
  return {
    id: errorId,
    type,
    userMessage: getErrorMessage(type, details),
    // Internal fields (logged but never shown)
    originalMessage: error?.message || String(error),
    timestamp: new Date().toISOString(),
    // Context for backend logging
    context: details,
  };
}

/**
 * Get appropriate user-facing message for error type
 */
function getErrorMessage(errorType, details = {}) {
  const messages = {
    AUTH_ERROR: () => {
      if (details.reason === 'locked') return ERROR_MESSAGES.AUTH_ACCOUNT_LOCKED;
      if (details.reason === 'invalid_credentials') return ERROR_MESSAGES.AUTH_INVALID_CREDENTIALS;
      if (details.reason === 'session_expired') return ERROR_MESSAGES.AUTH_SESSION_EXPIRED;
      return ERROR_MESSAGES.AUTH_INVALID_CREDENTIALS;
    },
    VALIDATION_ERROR: () => {
      if (details.field === 'email') return ERROR_MESSAGES.VALIDATION_EMAIL;
      if (details.field === 'password') return ERROR_MESSAGES.VALIDATION_PASSWORD;
      if (details.field === 'businessName') return ERROR_MESSAGES.VALIDATION_BUSINESS_NAME;
      return ERROR_MESSAGES.VALIDATION_REQUIRED_FIELD;
    },
    NETWORK_ERROR: () => ERROR_MESSAGES.NETWORK_ERROR,
    SERVER_ERROR: () => ERROR_MESSAGES.SERVER_ERROR,
    RATE_LIMIT: () => ERROR_MESSAGES.FORM_TOO_MANY_ATTEMPTS,
  };
  
  return (messages[errorType] || (() => ERROR_MESSAGES.GENERIC_ERROR))();
}

/**
 * Generate unique error ID for tracking
 */
function generateErrorId() {
  return `ERR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Log error securely (frontend) - send non-sensitive data to backend
 * Backend handles detailed logging with full context
 */
export function logErrorSecurely(safeError, sessionId = null) {
  // Never log sensitive data client-side
  const payload = {
    errorId: safeError.id,
    type: safeError.type,
    timestamp: safeError.timestamp,
    userAgent: navigator.userAgent,
    sessionId, // Could be null
    context: safeError.context,
    // Omit: originalMessage, personal data
  };
  
  // Try to send to backend error logging endpoint
  try {
    navigator.sendBeacon(
      `${process.env.REACT_APP_API_URL || ''}/api/v1/logs/client-error`,
      JSON.stringify(payload)
    );
  } catch (e) {
    // Silently fail - don't compound errors
    console.debug('[Error Logging] Failed to report error', safeError.id);
  }
}

/**
 * Classify HTTP response errors
 */
export function classifyHttpError(status, response) {
  if (status === 0) return 'NETWORK_ERROR';
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 400) return 'VALIDATION_ERROR';
  return 'UNKNOWN_ERROR';
}

/**
 * Handle async errors safely
 */
export async function handleAsyncError(asyncFn, context = '') {
  try {
    return await asyncFn();
  } catch (error) {
    const errorType = error.name || 'UNKNOWN_ERROR';
    const safeError = createSafeError(error, errorType);
    logErrorSecurely(safeError);
    return { error: safeError };
  }
}

export default {
  createSafeError,
  sanitizeErrorMessage,
  logErrorSecurely,
  classifyHttpError,
  handleAsyncError,
  ERROR_MESSAGES,
  ERROR_SEVERITY,
};
