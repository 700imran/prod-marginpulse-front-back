// Allow-list input validation. Every write endpoint passes the request
// body through a schema: unknown keys are DROPPED (never reach SQL or the
// ORM layer — this is what prevents mass-assignment and column-name
// injection), and each known key is type- and range-checked.

export type Rule =
  | { t: "bool" }
  | { t: "int"; min: number; max: number }
  | { t: "num"; min: number; max: number }
  | { t: "str"; max: number; pattern?: RegExp; allowEmpty?: boolean }
  | { t: "enum"; values: readonly string[] }
  | { t: "date" };

export type Schema = Record<string, Rule>;

export class ValidationError extends Error {
  constructor(public field: string, message: string) { super(`${field}: ${message}`); }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(field: string, v: unknown, r: Rule): unknown {
  switch (r.t) {
    case "bool":
      if (typeof v !== "boolean") throw new ValidationError(field, "must be true or false");
      return v;
    case "int": case "num": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(field, "must be a number");
      if (r.t === "int" && !Number.isInteger(n)) throw new ValidationError(field, "must be a whole number");
      if (n < r.min || n > r.max) throw new ValidationError(field, `must be between ${r.min} and ${r.max}`);
      return n;
    }
    case "str": {
      if (typeof v !== "string") throw new ValidationError(field, "must be text");
      const s = v.trim();
      if (s.length === 0 && !r.allowEmpty) throw new ValidationError(field, "must not be empty");
      if (s.length > r.max) throw new ValidationError(field, `must be at most ${r.max} characters`);
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) throw new ValidationError(field, "contains control characters");
      if (r.pattern && !r.pattern.test(s)) throw new ValidationError(field, "has an invalid format");
      return s;
    }
    case "enum":
      if (typeof v !== "string" || !r.values.includes(v)) throw new ValidationError(field, `must be one of ${r.values.join(", ")}`);
      return v;
    case "date": {
      if (typeof v !== "string" || !ISO_DATE.test(v)) throw new ValidationError(field, "must be a YYYY-MM-DD date");
      const [y, m, d] = v.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d)); // V8 rolls 31 Feb over to March, so round-trip the parts
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new ValidationError(field, "must be a real calendar date");
      return v;
    }
  }
}

/** Returns only the schema's keys, validated. Throws ValidationError on the first bad value. */
export function pickValid<T extends Schema>(body: unknown, schema: T): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("body", "must be a JSON object");
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    // Own-property only: blocks __proto__ / prototype pollution tricks.
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (v === undefined || v === null) continue; // null == "not provided" (frontend sends label: null)
    out[key] = check(key, v, schema[key]!);
  }
  return out;
}

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PHONE_RE = /^\+?[0-9]{7,15}$/;
export const COUNTRY_RE = /^[A-Z]{2}$/;
