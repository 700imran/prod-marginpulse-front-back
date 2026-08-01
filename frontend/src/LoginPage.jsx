/**
 * LoginPage.jsx — Secure Auth Gate
 * 
 * Design system: MarginPulse Pro — Real
 * - Clean, functional implementation-oriented style
 * - Neomorphism theme with green accents (#00c07f)
 * - WCAG 2.2 AA accessibility compliance
 * 
 * Security implementation:
 * - Client-side input validation (UX-first)
 * - Backend-first security (server validates all)
 * - Safe error messaging (no internal details exposed)
 * - Token-based auth with refresh capability
 * - Form submission rate limiting
 */

import { useState, useEffect } from "react";
import { apiClient } from "./security/apiClient";
import { tokenManager } from "./security/tokenManager";
import { validateEmail, validatePassword, validateBusinessName, validateDisplayName, validatePhoneNumber } from "./security/inputValidator";
import { ERROR_MESSAGES } from "./security/errorHandler";

const API_BASE = process.env.REACT_APP_API_URL || "";

const LOGIN_STYLES = `
  /* ──────────────────────────────────────────────────────────────────────────── */
  /* LOGIN PAGE CONTAINER */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #f5f7fa 0%, #e9ecef 100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 16px;
  }

  .mp-auth-card {
    background: #ffffff;
    border-radius: 16px;
    box-shadow: rgba(15, 23, 42, 0.08) 0px 8px 24px;
    padding: 40px;
    width: 100%;
    max-width: 420px;
    animation: fadeIn 0.3s ease-in-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* LOGO & HEADER */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-logo {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 28px;
  }

  .mp-auth-logo-icon {
    width: 30px;
    height: 30px;
    background: #00c07f;
    border-radius: 8px;
    transform: skewX(-10deg);
    box-shadow: 0 4px 10px rgba(0, 192, 127, 0.3);
    flex-shrink: 0;
  }

  .mp-auth-logo-text {
    font-size: 17px;
    font-weight: 800;
    color: #1e293b;
    letter-spacing: -0.02em;
  }

  .mp-auth-header {
    margin-bottom: 24px;
  }

  .mp-auth-title {
    font-size: 18px;
    font-weight: 700;
    color: #1e293b;
    margin: 0 0 8px 0;
  }

  .mp-auth-subtitle {
    font-size: 13px;
    color: #64748b;
    margin: 0;
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* TABS (LOGIN / REGISTER) */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
    border-bottom: 1px solid #e2e8f0;
  }

  .mp-auth-tab {
    flex: 1;
    padding: 12px 0;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    font-size: 13px;
    font-weight: 600;
    color: #64748b;
    cursor: pointer;
    transition: all 0.2s ease;
    outline: none;
  }

  .mp-auth-tab:hover {
    color: #1e293b;
  }

  .mp-auth-tab:focus-visible {
    border-bottom-color: #00c07f;
    color: #1e293b;
    box-shadow: inset 0 -2px 0 #00c07f;
  }

  .mp-auth-tab.active {
    color: #00c07f;
    border-bottom-color: #00c07f;
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* FORM FIELDS */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-form-group {
    margin-bottom: 16px;
  }

  .mp-auth-form-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #1e293b;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .mp-auth-form-input,
  .mp-auth-form-select {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    font-size: 14px;
    color: #1e293b;
    background: #f8fafc;
    font-family: inherit;
    transition: all 0.2s ease;
    box-sizing: border-box;
    outline: none;
  }

  .mp-auth-form-input::placeholder {
    color: #cbd5e1;
  }

  .mp-auth-form-input:hover,
  .mp-auth-form-select:hover {
    background: #f0f4f8;
    border-color: #cbd5e1;
  }

  .mp-auth-form-input:focus,
  .mp-auth-form-select:focus {
    background: #ffffff;
    border-color: #00c07f;
    box-shadow: 0 0 0 3px rgba(0, 192, 127, 0.1);
  }

  .mp-auth-form-input:disabled,
  .mp-auth-form-select:disabled {
    background: #f1f5f9;
    color: #94a3b8;
    cursor: not-allowed;
  }

  .mp-auth-form-input.error {
    border-color: #ef4444;
    background: rgba(239, 68, 68, 0.05);
  }

  .mp-auth-form-input.error:focus {
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* ERROR & SUCCESS MESSAGES */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-error-box {
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid #fecaca;
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 16px;
    font-size: 12px;
    color: #991b1b;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .mp-auth-error-icon {
    flex-shrink: 0;
    margin-top: 2px;
    font-weight: bold;
  }

  .mp-auth-field-error {
    font-size: 11px;
    color: #dc2626;
    margin-top: 4px;
    display: block;
  }

  .mp-auth-success-box {
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid #bbf7d0;
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 16px;
    font-size: 12px;
    color: #166534;
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* BUTTONS */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-btn {
    width: 100%;
    padding: 12px 0;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    outline: none;
    font-family: inherit;
  }

  .mp-auth-btn:focus-visible {
    box-shadow: 0 0 0 3px rgba(0, 192, 127, 0.3);
  }

  .mp-auth-btn-primary {
    background: #00c07f;
    color: #ffffff;
  }

  .mp-auth-btn-primary:hover {
    background: #00a86a;
  }

  .mp-auth-btn-primary:active {
    background: #008c54;
  }

  .mp-auth-btn-primary:disabled {
    background: #cbd5e1;
    color: #94a3b8;
    cursor: not-allowed;
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* LOADING STATE */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #ffffff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 6px;
    vertical-align: middle;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* HELPER TEXT */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-helper-text {
    font-size: 12px;
    color: #64748b;
    margin-top: 12px;
    text-align: center;
  }

  .mp-auth-helper-text a {
    color: #00c07f;
    text-decoration: none;
    font-weight: 600;
  }

  .mp-auth-helper-text a:hover {
    text-decoration: underline;
  }

  .mp-auth-helper-text a:focus-visible {
    outline: 2px solid #00c07f;
    outline-offset: 2px;
    border-radius: 2px;
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* FORM GRID (for multi-column layouts) */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  @media (max-width: 500px) {
    .mp-auth-form-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /* RESPONSIVE */
  /* ──────────────────────────────────────────────────────────────────────────── */
  @media (max-width: 500px) {
    .mp-auth-card {
      padding: 32px 24px;
    }

    .mp-auth-title {
      font-size: 16px;
    }
  }
  /* ──────────────────────────────────────────────────────────────────────────── */
  /* OAUTH BUTTONS (Google / Apple) */
  /* ──────────────────────────────────────────────────────────────────────────── */
  .mp-auth-oauth-row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 20px;
  }

  .mp-auth-oauth-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 11px 0;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    color: #1e293b;
    background: #ffffff;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: inherit;
    text-decoration: none;
  }

  .mp-auth-oauth-btn:hover {
    background: #f8fafc;
    border-color: #cbd5e1;
  }

  .mp-auth-oauth-btn:focus-visible {
    box-shadow: 0 0 0 3px rgba(0, 192, 127, 0.2);
  }

  .mp-auth-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 4px 0 20px 0;
    color: #94a3b8;
    font-size: 12px;
    font-weight: 600;
  }

  .mp-auth-divider::before,
  .mp-auth-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: #e2e8f0;
  }
`;

/**
 * Input field component with error state
 */
function AuthInput({
  type = "text",
  placeholder,
  value,
  onChange,
  onBlur,
  disabled,
  error,
  label,
  required,
  maxLength,
  autoComplete,
  ariaDescribedby,
  id,
}) {
  return (
    <div className="mp-auth-form-group">
      {label && (
        <label htmlFor={id} className="mp-auth-form-label">
          {label} {required && <span aria-hidden="true">*</span>}
        </label>
      )}
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-describedby={ariaDescribedby}
        className={`mp-auth-form-input ${error ? 'error' : ''}`}
        required={required}
      />
      {error && (
        <span id={ariaDescribedby} className="mp-auth-field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * "Continue with Google/Apple" buttons — plain full-page redirects to
 * the backend's OAuth login endpoints (internal/httpapi/oauth_handlers.go),
 * not fetch() calls, since an OAuth authorization flow inherently needs
 * a real browser navigation to the provider's consent screen.
 */
function OAuthButtons() {
  return (
    <div className="mp-auth-oauth-row">
      <a className="mp-auth-oauth-btn" href={`${API_BASE}/api/v1/auth/google/login`}>
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.9 32.9 29.4 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.4-.1-2.7-.4-3.5z"/>
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.5 5.1 29.5 3 24 3 16.3 3 9.7 7.3 6.3 14.7z"/>
          <path fill="#4CAF50" d="M24 45c5.3 0 10.2-2 13.9-5.4l-6.4-5.4C29.4 35.9 26.8 37 24 37c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.6 40.6 16.2 45 24 45z"/>
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.9 2.5-2.5 4.6-4.6 6.1l6.4 5.4C40.8 36.9 44 31.4 44 24c0-1.4-.1-2.7-.4-3.5z"/>
        </svg>
        Continue with Google
      </a>
      <a className="mp-auth-oauth-btn" href={`${API_BASE}/api/v1/auth/apple/login`}>
        <svg width="15" height="15" viewBox="0 0 384 512" aria-hidden="true" fill="#000">
          <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141 4 184.8 4 273.5c0 26.2 4.8 53.3 14.4 81.2 12.8 37.5 59 129.3 107.2 127.8 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-84.1 102.6-121.7-65.2-30.7-61.7-90-61.7-92.1zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
        </svg>
        Continue with Apple
      </a>
    </div>
  );
}

/**
 * Login form component
 */
function LoginForm({ onSuccess }) {
  const [form, setForm] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState("");
  const [touched, setTouched] = useState({});

  const handleChange = (field) => (e) => {
    setForm(f => ({ ...f, [field]: e.target.value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(e => ({ ...e, [field]: "" }));
    }
  };

  const handleBlur = (field) => () => {
    setTouched(t => ({ ...t, [field]: true }));
    
    // Validate on blur
    let fieldError = "";
    if (field === "email") {
      const result = validateEmail(form.email);
      fieldError = result.valid ? "" : result.error;
    } else if (field === "password") {
      const result = validatePassword(form.password);
      fieldError = result.valid ? "" : result.error;
    }
    
    if (fieldError) {
      setErrors(e => ({ ...e, [field]: fieldError }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError("");
    setErrors({});

    // Validate all fields
    const emailValidation = validateEmail(form.email);
    const passwordValidation = validatePassword(form.password);

    if (!emailValidation.valid || !passwordValidation.valid) {
      setErrors({
        email: emailValidation.valid ? "" : emailValidation.error,
        password: passwordValidation.valid ? "" : passwordValidation.error,
      });
      return;
    }

    setSubmitting(true);

    // Call API with secure client
    const response = await apiClient.post('/api/v1/auth/login', {
      email: form.email.trim().toLowerCase(),
      password: form.password,
    });

    setSubmitting(false);

    if (!response.success) {
      setApiError(response.userMessage || ERROR_MESSAGES.GENERIC_ERROR);
      return;
    }

    const { data } = response;
    if (data?.access_token && data?.refresh_token) {
      tokenManager.setTokens(
        data.access_token,
        data.refresh_token,
        data.tenant_id,
        data.expires_in || 3600
      );
      onSuccess?.();
    } else {
      setApiError(ERROR_MESSAGES.GENERIC_ERROR);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {apiError && (
        <div className="mp-auth-error-box" role="alert">
          <span className="mp-auth-error-icon">⚠</span>
          <span>{apiError}</span>
        </div>
      )}

      <AuthInput
        id="login-email"
        type="email"
        label="Email Address"
        placeholder="you@example.com"
        value={form.email}
        onChange={handleChange("email")}
        onBlur={handleBlur("email")}
        error={touched.email ? errors.email : ""}
        disabled={submitting}
        autoComplete="email"
        ariaDescribedby="login-email-error"
        required
      />

      <AuthInput
        id="login-password"
        type="password"
        label="Password"
        placeholder="••••••••"
        value={form.password}
        onChange={handleChange("password")}
        onBlur={handleBlur("password")}
        error={touched.password ? errors.password : ""}
        disabled={submitting}
        autoComplete="current-password"
        ariaDescribedby="login-password-error"
        maxLength={128}
        required
      />

      <button
        type="submit"
        className="mp-auth-btn mp-auth-btn-primary"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? (
          <>
            <span className="mp-auth-spinner" aria-hidden="true"></span>
            Signing in…
          </>
        ) : (
          'Sign In'
        )}
      </button>

      <p className="mp-auth-helper-text">
        Don't have an account? <a href="#register" onClick={(e) => { e.preventDefault(); }}>Create one</a>
      </p>
    </form>
  );
}

/**
 * Register form component
 */
function RegisterForm({ onSuccess }) {
  const [form, setForm] = useState({
    businessName: "",
    email: "",
    password: "",
    confirmPassword: "",
    countryCode: "IND",
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState("");
  const [touched, setTouched] = useState({});

  const handleChange = (field) => (e) => {
    setForm(f => ({ ...f, [field]: e.target.value }));
    if (errors[field]) {
      setErrors(e => ({ ...e, [field]: "" }));
    }
  };

  const handleBlur = (field) => () => {
    setTouched(t => ({ ...t, [field]: true }));

    let fieldError = "";
    if (field === "businessName") {
      const result = validateBusinessName(form.businessName);
      fieldError = result.valid ? "" : result.error;
    } else if (field === "email") {
      const result = validateEmail(form.email);
      fieldError = result.valid ? "" : result.error;
    } else if (field === "password") {
      const result = validatePassword(form.password);
      fieldError = result.valid ? "" : result.error;
    } else if (field === "confirmPassword") {
      if (form.password !== form.confirmPassword) {
        fieldError = "Passwords do not match";
      }
    }

    if (fieldError) {
      setErrors(e => ({ ...e, [field]: fieldError }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError("");
    setErrors({});

    // Validate all fields
    const businessValidation = validateBusinessName(form.businessName);
    const emailValidation = validateEmail(form.email);
    const passwordValidation = validatePassword(form.password);
    const confirmMatch = form.password === form.confirmPassword;

    const newErrors = {
      businessName: businessValidation.valid ? "" : businessValidation.error,
      email: emailValidation.valid ? "" : emailValidation.error,
      password: passwordValidation.valid ? "" : passwordValidation.error,
      confirmPassword: confirmMatch ? "" : "Passwords do not match",
    };

    if (Object.values(newErrors).some(e => e)) {
      setErrors(newErrors);
      return;
    }

    setSubmitting(true);

    const response = await apiClient.post('/api/v1/auth/register', {
      business_name: form.businessName.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      country_code: form.countryCode,
    });

    setSubmitting(false);

    if (!response.success) {
      setApiError(response.userMessage || ERROR_MESSAGES.GENERIC_ERROR);
      return;
    }

    const { data } = response;
    if (data?.access_token && data?.refresh_token) {
      tokenManager.setTokens(
        data.access_token,
        data.refresh_token,
        data.tenant_id,
        data.expires_in || 3600
      );
      onSuccess?.();
    } else {
      setApiError(ERROR_MESSAGES.GENERIC_ERROR);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {apiError && (
        <div className="mp-auth-error-box" role="alert">
          <span className="mp-auth-error-icon">⚠</span>
          <span>{apiError}</span>
        </div>
      )}

      <AuthInput
        id="register-business"
        type="text"
        label="Business Name"
        placeholder="Your Firm Name"
        value={form.businessName}
        onChange={handleChange("businessName")}
        onBlur={handleBlur("businessName")}
        error={touched.businessName ? errors.businessName : ""}
        disabled={submitting}
        maxLength={255}
        required
      />

      <AuthInput
        id="register-email"
        type="email"
        label="Email Address"
        placeholder="you@example.com"
        value={form.email}
        onChange={handleChange("email")}
        onBlur={handleBlur("email")}
        error={touched.email ? errors.email : ""}
        disabled={submitting}
        autoComplete="email"
        required
      />

      <div className="mp-auth-form-grid">
        <AuthInput
          id="register-password"
          type="password"
          label="Password"
          placeholder="••••••••"
          value={form.password}
          onChange={handleChange("password")}
          onBlur={handleBlur("password")}
          error={touched.password ? errors.password : ""}
          disabled={submitting}
          autoComplete="new-password"
          maxLength={128}
          required
        />

        <AuthInput
          id="register-confirm"
          type="password"
          label="Confirm Password"
          placeholder="••••••••"
          value={form.confirmPassword}
          onChange={handleChange("confirmPassword")}
          onBlur={handleBlur("confirmPassword")}
          error={touched.confirmPassword ? errors.confirmPassword : ""}
          disabled={submitting}
          autoComplete="new-password"
          maxLength={128}
          required
        />
      </div>

      <div className="mp-auth-form-group">
        <label htmlFor="country" className="mp-auth-form-label">Country</label>
        <select
          id="country"
          value={form.countryCode}
          onChange={handleChange("countryCode")}
          disabled={submitting}
          className="mp-auth-form-select"
        >
          <option value="IND">India</option>
          <option value="USA">United States</option>
          <option value="GBR">United Kingdom</option>
          <option value="CAN">Canada</option>
          <option value="AUS">Australia</option>
        </select>
      </div>

      <button
        type="submit"
        className="mp-auth-btn mp-auth-btn-primary"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? (
          <>
            <span className="mp-auth-spinner" aria-hidden="true"></span>
            Creating account…
          </>
        ) : (
          'Create Account'
        )}
      </button>

      <p className="mp-auth-helper-text">
        Already have an account? <a href="#login" onClick={(e) => { e.preventDefault(); }}>Sign in</a>
      </p>
    </form>
  );
}

/**
 * Main LoginPage component
 */
export default function LoginPage({ onSuccess }) {
  const [tab, setTab] = useState("login");
  const [oauthError, setOauthError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("oauth_error");
    if (err) {
      setOauthError(err);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  return (
    <>
      <style>{LOGIN_STYLES}</style>
      <div className="mp-auth-page">
        <div className="mp-auth-card">
          {/* Logo & Header */}
          <div className="mp-auth-logo">
            <div className="mp-auth-logo-icon" aria-hidden="true"></div>
            <div className="mp-auth-logo-text">MarginPulse</div>
          </div>

          <div className="mp-auth-header">
            <h1 className="mp-auth-title">
              {tab === "login" ? "Welcome Back" : "Create Account"}
            </h1>
            <p className="mp-auth-subtitle">
              {tab === "login" ? "Sign in to your workspace" : "Set up your MarginPulse account"}
            </p>
          </div>

          {oauthError && (
            <div className="mp-auth-error-box" role="alert">
              <span className="mp-auth-error-icon">⚠</span>
              <span>{oauthError}</span>
            </div>
          )}

          <OAuthButtons />
          <div className="mp-auth-divider">or use your email</div>

          {/* Tabs */}
          <div className="mp-auth-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "login"}
              aria-controls="login-panel"
              className={`mp-auth-tab ${tab === "login" ? "active" : ""}`}
              onClick={() => setTab("login")}
            >
              Sign In
            </button>
            <button
              role="tab"
              aria-selected={tab === "register"}
              aria-controls="register-panel"
              className={`mp-auth-tab ${tab === "register" ? "active" : ""}`}
              onClick={() => setTab("register")}
            >
              Sign Up
            </button>
          </div>

          {/* Tab Panels */}
          {tab === "login" && (
            <div id="login-panel" role="tabpanel">
              <LoginForm onSuccess={onSuccess} />
            </div>
          )}

          {tab === "register" && (
            <div id="register-panel" role="tabpanel">
              <RegisterForm onSuccess={onSuccess} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
