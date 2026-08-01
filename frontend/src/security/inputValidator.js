/**
 * inputValidator.js — Client-side input validation
 * 
 * Context-aware validation rules:
 * - Email: RFC 5322 compliant (basic client check)
 * - Password: strength requirements enforced
 * - Text fields: length limits, special char handling
 * - Business names: whitespace normalization
 * 
 * NOTE: Backend MUST always validate all inputs.
 * Frontend validation is UX-first; backend validation is security-first.
 */

/**
 * Email validation
 * Client-side: basic RFC 5322 pattern
 * Backend: DNS verification, duplicate check, activation link
 */
export function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }
  
  const trimmed = email.trim().toLowerCase();
  
  // Basic RFC 5322 pattern (not exhaustive - backend validates fully)
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (!emailPattern.test(trimmed)) {
    return { valid: false, error: 'Invalid email format' };
  }
  
  if (trimmed.length > 254) {
    return { valid: false, error: 'Email is too long' };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Password validation
 * Minimum requirements:
 * - 8+ characters
 * - Mix of uppercase, lowercase, numbers, special chars (recommended not enforced)
 * Backend: Argon2id hashing with salt
 */
export function validatePassword(password, options = {}) {
  const { 
    minLength = 8, 
    requireMix = false 
  } = options;
  
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  
  if (password.length < minLength) {
    return { valid: false, error: `Password must be at least ${minLength} characters` };
  }
  
  if (password.length > 128) {
    return { valid: false, error: 'Password is too long' };
  }
  
  // Optional: check for common weak patterns (client-side courtesy)
  const weakPatterns = ['123456', 'password', 'qwerty', '111111'];
  if (weakPatterns.some(p => password.toLowerCase().includes(p))) {
    return { valid: false, error: 'Password is too common - please choose a stronger one' };
  }
  
  if (requireMix) {
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
    
    if (!(hasUpper && hasLower && hasNumber)) {
      return { 
        valid: false, 
        error: 'Password should contain uppercase, lowercase, and numbers' 
      };
    }
  }
  
  return { valid: true };
}

/**
 * Password match validation
 */
export function validatePasswordMatch(password, confirm) {
  if (password !== confirm) {
    return { valid: false, error: 'Passwords do not match' };
  }
  return { valid: true };
}

/**
 * Business name validation
 * Allows alphanumerics, spaces, hyphens, ampersands, dots
 * Sanitizes whitespace
 */
export function validateBusinessName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Business name is required' };
  }
  
  const trimmed = name.trim();
  
  if (trimmed.length < 2) {
    return { valid: false, error: 'Business name must be at least 2 characters' };
  }
  
  if (trimmed.length > 255) {
    return { valid: false, error: 'Business name is too long' };
  }
  
  // Allow alphanumerics, spaces, common business characters
  const businessNamePattern = /^[a-zA-Z0-9\s\-&.,'()]+$/;
  if (!businessNamePattern.test(trimmed)) {
    return { valid: false, error: 'Business name contains invalid characters' };
  }
  
  // Normalize: collapse multiple spaces
  const normalized = trimmed.replace(/\s+/g, ' ');
  
  return { valid: true, value: normalized };
}

/**
 * Display name validation
 * Similar to business name but slightly stricter
 */
export function validateDisplayName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Name is required' };
  }
  
  const trimmed = name.trim();
  
  if (trimmed.length < 2) {
    return { valid: false, error: 'Name must be at least 2 characters' };
  }
  
  if (trimmed.length > 255) {
    return { valid: false, error: 'Name is too long' };
  }
  
  // Allow alphanumerics, spaces, periods, hyphens
  const namePattern = /^[a-zA-Z0-9\s.\-]+$/;
  if (!namePattern.test(trimmed)) {
    return { valid: false, error: 'Name contains invalid characters' };
  }
  
  const normalized = trimmed.replace(/\s+/g, ' ');
  return { valid: true, value: normalized };
}

/**
 * Phone number validation
 * Accepts international format, stores normalized form
 */
export function validatePhoneNumber(phone) {
  if (!phone) {
    return { valid: true, value: null }; // Optional field
  }
  
  if (typeof phone !== 'string') {
    return { valid: false, error: 'Phone number is invalid' };
  }
  
  const trimmed = phone.trim();
  
  // Remove common formatting: spaces, dashes, parentheses
  const cleaned = trimmed.replace(/[\s\-().]/g, '');
  
  if (!/^\+?[0-9]{7,15}$/.test(cleaned)) {
    return { valid: false, error: 'Phone number must be 7-15 digits' };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Generic text field validation
 * Prevents null bytes, excessive whitespace
 */
export function validateTextField(value, { 
  maxLength = 255, 
  minLength = 1,
  allowEmpty = false,
  fieldName = 'Field'
} = {}) {
  if (!value) {
    if (allowEmpty) return { valid: true, value: '' };
    return { valid: false, error: `${fieldName} is required` };
  }
  
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be text` };
  }
  
  const trimmed = value.trim();
  
  if (trimmed.length < minLength && !allowEmpty) {
    return { valid: false, error: `${fieldName} is too short` };
  }
  
  if (trimmed.length > maxLength) {
    return { valid: false, error: `${fieldName} is too long` };
  }
  
  // Prevent null bytes
  if (trimmed.includes('\x00')) {
    return { valid: false, error: `${fieldName} contains invalid characters` };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Batch validation for form objects
 * Returns all errors at once for better UX
 */
export function validateForm(data, schema) {
  const errors = {};
  const cleaned = {};
  
  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];
    let result;
    
    if (rules.type === 'email') {
      result = validateEmail(value);
    } else if (rules.type === 'password') {
      result = validatePassword(value, rules.options);
    } else if (rules.type === 'businessName') {
      result = validateBusinessName(value);
    } else if (rules.type === 'displayName') {
      result = validateDisplayName(value);
    } else if (rules.type === 'phone') {
      result = validatePhoneNumber(value);
    } else if (rules.type === 'text') {
      result = validateTextField(value, { ...rules.options, fieldName: field });
    } else {
      result = { valid: true, value };
    }
    
    if (!result.valid) {
      errors[field] = result.error;
    } else if (result.value !== undefined) {
      cleaned[field] = result.value;
    } else {
      cleaned[field] = value;
    }
  }
  
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    cleaned,
  };
}

export default {
  validateEmail,
  validatePassword,
  validatePasswordMatch,
  validateBusinessName,
  validateDisplayName,
  validatePhoneNumber,
  validateTextField,
  validateForm,
};
