// The backend (backend-cloudflare/src/errors.ts) returns errors as
//   { success: false, error: { code, message, requestId, details? } }
// but the views written against the earlier API read `result.error` as a
// STRING (GSTSyncView, DashboardView) or `result.detail` (everywhere else) and
// hand it straight to a toast. Passing the new object there would render
// "[object Object]" or crash React. normalizeErrorBody() bridges the two in one
// place: `error` and `detail` become the human message, and the structured
// fields stay available as error_code / request_id / error_details.
// Success bodies, and bodies already in the old shape, pass through untouched.
export function normalizeErrorBody(body) {
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
    const { code, message, requestId, details } = body.error;
    const text = typeof message === 'string' && message ? message : 'Something went wrong. Please try again.';
    return {
      ...body,
      error: text,
      detail: typeof body.detail === 'string' ? body.detail : text,
      error_code: code,
      request_id: requestId,
      ...(details ? { error_details: details } : {}),
    };
  }
  return body;
}
