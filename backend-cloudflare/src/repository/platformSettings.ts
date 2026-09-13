import type { Sql } from "../db";

export interface PlatformSettings {
  aiInsightsEnabled: boolean;
  whatsappIngestEnabled: boolean;
  emailIngestEnabled: boolean;
  razorpayIntegrationOn: boolean;
  stripeIntegrationOn: boolean;
  slackIntegrationOn: boolean;
  newSignupsEnabled: boolean;
}

export async function getPlatformSettings(sql: Sql): Promise<PlatformSettings> {
  const rows = await sql<PlatformSettings[]>`
    select ai_insights_enabled as "aiInsightsEnabled", whatsapp_ingest_enabled as "whatsappIngestEnabled",
           email_ingest_enabled as "emailIngestEnabled", razorpay_integration_on as "razorpayIntegrationOn",
           stripe_integration_on as "stripeIntegrationOn", slack_integration_on as "slackIntegrationOn",
           new_signups_enabled as "newSignupsEnabled"
    from platform_settings where id = 1
  `;
  return rows[0]!;
}

export async function updatePlatformSettings(sql: Sql, patch: Partial<PlatformSettings>, updatedBy: string): Promise<void> {
  const colMap: Record<keyof PlatformSettings, string> = {
    aiInsightsEnabled: "ai_insights_enabled",
    whatsappIngestEnabled: "whatsapp_ingest_enabled",
    emailIngestEnabled: "email_ingest_enabled",
    razorpayIntegrationOn: "razorpay_integration_on",
    stripeIntegrationOn: "stripe_integration_on",
    slackIntegrationOn: "slack_integration_on",
    newSignupsEnabled: "new_signups_enabled",
  };
  const cols = Object.keys(patch) as (keyof PlatformSettings)[];
  if (cols.length === 0) return;
  const setClause = cols.map((c, i) => `${colMap[c]} = $${i + 1}`).join(", ");
  await sql.unsafe(
    `update platform_settings set ${setClause}, updated_at = now(), updated_by = $${cols.length + 1} where id = 1`,
    [...cols.map((c) => patch[c]!), updatedBy],
  );
}

// Slack app credentials, admin-configurable at runtime (matches the Go
// original storing these in the platform_settings row rather than as
// deploy-time env vars — an admin can rotate the Slack app without a
// redeploy). client_secret is encrypted at rest with the same
// FIELD_ENCRYPTION_KEY as bank account numbers.
export interface SlackAppConfig {
  slackClientId: string | null;
  slackClientSecretEncrypted: string | null;
  slackRedirectUri: string | null;
}
export async function getSlackAppConfig(sql: Sql): Promise<SlackAppConfig> {
  const rows = await sql<SlackAppConfig[]>`
    select slack_client_id as "slackClientId", slack_client_secret_encrypted as "slackClientSecretEncrypted",
           slack_redirect_uri as "slackRedirectUri"
    from platform_settings where id = 1
  `;
  return rows[0]!;
}
export async function setSlackAppConfig(sql: Sql, cfg: { slackClientId: string; slackClientSecretEncrypted: string; slackRedirectUri: string }, updatedBy: string): Promise<void> {
  await sql`
    update platform_settings set
      slack_client_id = ${cfg.slackClientId}, slack_client_secret_encrypted = ${cfg.slackClientSecretEncrypted},
      slack_redirect_uri = ${cfg.slackRedirectUri}, updated_at = now(), updated_by = ${updatedBy}
    where id = 1
  `;
}
