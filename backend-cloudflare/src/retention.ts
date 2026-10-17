// Central retention settings — the numbers a "don't scatter hardcoded
// values" requirement asks to live in exactly one place. src/purge.ts's
// queries and src/routes/auth.ts's cancel-deletion check both read from
// here rather than each having their own copy of "30 days".
export const RETENTION = {
  // How long a self-service "delete my account" request sits reversible
  // before the account and everything in it is actually purged. The
  // account stays fully usable during this window — see db/schema.sql's
  // comment on tenants.deletion_requested_at for why.
  TENANT_DELETION_GRACE_DAYS: 30,

  // How long a soft-deleted document can be restored before its row and
  // R2 object are permanently removed.
  DOCUMENT_TRASH_GRACE_DAYS: 30,

  // How long audit_log rows are kept before the purge job deletes them.
  // Chosen as a little over a year — long enough to cover an annual
  // compliance review, not indefinite. Adjust based on your actual
  // regulatory retention requirement; this is not legal advice.
  AUDIT_LOG_RETENTION_DAYS: 400,
} as const;
