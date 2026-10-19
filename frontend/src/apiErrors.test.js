import { normalizeErrorBody } from "./apiErrors";

const envelope = (code, message, extra = {}) => ({ success: false, error: { code, message, requestId: "r1", ...extra } });

test("error becomes a string the old toast code can render, and detail mirrors it", () => {
  const n = normalizeErrorBody(envelope("VALIDATION_ERROR", "No GSTIN registered for this account"));
  expect(typeof n.error).toBe("string");
  expect(n.error).toBe("No GSTIN registered for this account");
  expect(n.detail).toBe("No GSTIN registered for this account");
  // exactly what GSTSyncView / DashboardView / ProfileView do:
  expect(n.error || n.detail || "fallback").toBe("No GSTIN registered for this account");
});
test("structured fields stay available", () => {
  const n = normalizeErrorBody(envelope("INSUFFICIENT_CREDITS", "no credits", { details: { credits_remaining: 0 } }));
  expect(n.error_code).toBe("INSUFFICIENT_CREDITS");
  expect(n.request_id).toBe("r1");
  expect(n.error_details).toEqual({ credits_remaining: 0 });
  expect(n.success).toBe(false);
});
test("success bodies and old-shape bodies pass through untouched", () => {
  const ok = { job_id: "j", gstin: "g" };
  expect(normalizeErrorBody(ok)).toBe(ok);
  const old = { error: "plain string" };
  expect(normalizeErrorBody(old)).toBe(old);
  const fastapi = { detail: "old style" };
  expect(normalizeErrorBody(fastapi)).toBe(fastapi);
  expect(normalizeErrorBody(null)).toBeNull();
  expect(normalizeErrorBody([1, 2])).toEqual([1, 2]);
});
test("never yields a non-string message, even for malformed envelopes", () => {
  for (const bad of [{ error: {} }, { error: { message: { x: 1 } } }, { error: { message: "" } }]) {
    const n = normalizeErrorBody(bad);
    expect(typeof n.error).toBe("string");
    expect(typeof n.detail).toBe("string");
  }
});
