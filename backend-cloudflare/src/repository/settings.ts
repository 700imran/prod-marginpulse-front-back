import type { Sql } from "../db";

export interface ReconciliationSettings {
  fuzzyVendorMatching: boolean;
  dateDriftToleranceDays: number;
  ocrConfidenceThreshold: number;
}
export interface NotificationSettings {
  criticalItcMissingAlert: boolean;
  criticalItcThresholdInr: number;
  weeklyAuditSummary: boolean;
}
export interface IntegrationSettings {
  gstAutoSyncEnabled: boolean;
  gstAutoSyncDayOfMonth: number;
  whatsappOutboundEnabled: boolean;
}

async function upsertRow<T extends Record<string, unknown>>(sql: Sql, table: string, tenantId: string, patch: T): Promise<void> {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const colToSnake = (c: string) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const setClause = cols.map((c, i) => `${colToSnake(c)} = $${i + 2}`).join(", ");
  const insertCols = cols.map(colToSnake).join(", ");
  const insertPlaceholders = cols.map((_, i) => `$${i + 2}`).join(", ");
  await sql.unsafe(
    `insert into ${table} (tenant_id, ${insertCols}) values ($1, ${insertPlaceholders})
     on conflict (tenant_id) do update set ${setClause}, updated_at = now()`,
    [tenantId, ...cols.map((c) => patch[c] as any)],
  );
}

export async function getReconciliationSettings(sql: Sql, tenantId: string): Promise<ReconciliationSettings> {
  const rows = await sql<ReconciliationSettings[]>`
    select fuzzy_vendor_matching as "fuzzyVendorMatching", date_drift_tolerance_days as "dateDriftToleranceDays",
           ocr_confidence_threshold as "ocrConfidenceThreshold"
    from reconciliation_settings where tenant_id = ${tenantId}
  `;
  return rows[0] ?? { fuzzyVendorMatching: true, dateDriftToleranceDays: 3, ocrConfidenceThreshold: 0.75 };
}
export async function updateReconciliationSettings(sql: Sql, tenantId: string, patch: Partial<ReconciliationSettings>): Promise<void> {
  await upsertRow(sql, "reconciliation_settings", tenantId, patch);
}

export async function getNotificationSettings(sql: Sql, tenantId: string): Promise<NotificationSettings> {
  const rows = await sql<NotificationSettings[]>`
    select critical_itc_missing_alert as "criticalItcMissingAlert", critical_itc_threshold_inr as "criticalItcThresholdInr",
           weekly_audit_summary as "weeklyAuditSummary"
    from notification_settings where tenant_id = ${tenantId}
  `;
  return rows[0] ?? { criticalItcMissingAlert: true, criticalItcThresholdInr: 50000, weeklyAuditSummary: true };
}
export async function updateNotificationSettings(sql: Sql, tenantId: string, patch: Partial<NotificationSettings>): Promise<void> {
  await upsertRow(sql, "notification_settings", tenantId, patch);
}

export async function getIntegrationSettings(sql: Sql, tenantId: string): Promise<IntegrationSettings> {
  const rows = await sql<IntegrationSettings[]>`
    select gst_auto_sync_enabled as "gstAutoSyncEnabled", gst_auto_sync_day_of_month as "gstAutoSyncDayOfMonth",
           whatsapp_outbound_enabled as "whatsappOutboundEnabled"
    from integration_settings where tenant_id = ${tenantId}
  `;
  return rows[0] ?? { gstAutoSyncEnabled: false, gstAutoSyncDayOfMonth: 11, whatsappOutboundEnabled: false };
}
export async function updateIntegrationSettings(sql: Sql, tenantId: string, patch: Partial<IntegrationSettings>): Promise<void> {
  await upsertRow(sql, "integration_settings", tenantId, patch);
}
