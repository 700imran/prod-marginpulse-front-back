import { invalidateTenantCache } from "../auth/supabase";
import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth, requirePlatformAdmin } from "../middleware/auth";
import { pickValid } from "../security/validate";
import { getPlatformSettings, updatePlatformSettings, getSlackAppConfig, setSlackAppConfig, type PlatformSettings } from "../repository/platformSettings";
import { listAllTenants, setTenantActive, countTenants, getTenantById } from "../repository/tenants";
import { encryptField } from "../security/fieldEncryption";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

adminRoutes.use("*", requireAuth, requirePlatformAdmin);

const MASKED = "••••••••";
const maskSecret = (v: string | null) => (v ? MASKED : "");

async function buildSettingsResponse(sql: Sql) {
  const [settings, slack] = await Promise.all([getPlatformSettings(sql), getSlackAppConfig(sql)]);
  return {
    slack_client_id: slack.slackClientId ?? "",
    slack_client_secret: maskSecret(slack.slackClientSecretEncrypted),
    slack_redirect_uri: slack.slackRedirectUri ?? "",
    ai_insights_enabled: settings.aiInsightsEnabled,
    whatsapp_ingest_enabled: settings.whatsappIngestEnabled,
    email_ingest_enabled: settings.emailIngestEnabled,
    razorpay_integration_enabled: settings.razorpayIntegrationOn,
    stripe_integration_enabled: settings.stripeIntegrationOn,
    slack_integration_enabled: settings.slackIntegrationOn,
    new_signups_enabled: settings.newSignupsEnabled,
  };
}

// GET /admin/settings — mirrors HandleGetPlatformSettings, minus the
// Google/Apple OAuth credential fields entirely: those providers are
// now configured in the Supabase dashboard (Authentication > Providers)
// since Supabase Auth owns that flow, not this app. Slack (a
// notification integration, not a login provider) still lives here.
adminRoutes.get("/settings", async (c) => c.json(await buildSettingsResponse(c.get("sql"))));

// PATCH /admin/settings — mirrors HandleUpdatePlatformSettings: a
// masked value sent back unchanged means "leave as-is", same rule as
// the Go original.
adminRoutes.patch("/settings", async (c) => {
  const req = pickValid(await c.req.json().catch(() => null), {
    slack_client_id: { t: "str", max: 100, allowEmpty: true }, slack_client_secret: { t: "str", max: 200, allowEmpty: true }, slack_redirect_uri: { t: "str", max: 300, allowEmpty: true, pattern: /^$|^https:\/\/[^\s]+$/ },
    ai_insights_enabled: { t: "bool" }, whatsapp_ingest_enabled: { t: "bool" }, email_ingest_enabled: { t: "bool" },
    razorpay_integration_enabled: { t: "bool" }, stripe_integration_enabled: { t: "bool" }, slack_integration_enabled: { t: "bool" }, new_signups_enabled: { t: "bool" },
  }) as Record<string, any>;
  const sql = c.get("sql");
  const tenant = c.get("tenant");

  if (req.slack_client_id !== undefined || req.slack_client_secret !== undefined || req.slack_redirect_uri !== undefined) {
    const current = await getSlackAppConfig(sql);
    const clientId = req.slack_client_id ?? current.slackClientId ?? "";
    const redirectUri = req.slack_redirect_uri ?? current.slackRedirectUri ?? "";
    let secretEncrypted = current.slackClientSecretEncrypted ?? "";
    if (req.slack_client_secret && req.slack_client_secret !== MASKED) {
      secretEncrypted = await encryptField(c.env, req.slack_client_secret);
    }
    await setSlackAppConfig(sql, { slackClientId: clientId, slackClientSecretEncrypted: secretEncrypted, slackRedirectUri: redirectUri }, tenant.ownerEmail);
  }

  const flagPatch: Partial<PlatformSettings> = {};
  const flagMap: [string, keyof PlatformSettings][] = [
    ["ai_insights_enabled", "aiInsightsEnabled"], ["whatsapp_ingest_enabled", "whatsappIngestEnabled"],
    ["email_ingest_enabled", "emailIngestEnabled"], ["razorpay_integration_enabled", "razorpayIntegrationOn"],
    ["stripe_integration_enabled", "stripeIntegrationOn"], ["slack_integration_enabled", "slackIntegrationOn"],
    ["new_signups_enabled", "newSignupsEnabled"],
  ];
  for (const [jsonKey, field] of flagMap) {
    if (req[jsonKey] !== undefined) (flagPatch as any)[field] = req[jsonKey];
  }
  if (Object.keys(flagPatch).length > 0) await updatePlatformSettings(sql, flagPatch, tenant.ownerEmail);

  return c.json(await buildSettingsResponse(sql));
});

// GET /admin/tenants
adminRoutes.get("/tenants", async (c) => {
  const items = await listAllTenants(c.get("sql"), 200, 0);
  return c.json({ items, total: items.length });
});

// PATCH /admin/tenants/:id/active — suspend/reactivate without deleting data.
adminRoutes.patch("/tenants/:id/active", async (c) => {
  const { is_active } = pickValid(await c.req.json().catch(() => null), { is_active: { t: "bool" } }) as { is_active: boolean };
  const tenantId = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return c.json({ error: "invalid tenant id" }, 400);
  await setTenantActive(c.get("sql"), tenantId, Boolean(is_active));
  invalidateTenantCache(tenantId);
  const updated = await getTenantById(c.get("sql"), tenantId);
  if (!updated) return c.json({ error: "tenant not found" }, 404);
  return c.json(updated);
});

// GET /admin/stats
adminRoutes.get("/stats", async (c) => {
  const sql = c.get("sql");
  const items = await listAllTenants(sql, 500, 0);
  const active = items.filter((t) => t.isActive).length;
  const total = await countTenants(sql);
  return c.json({ total_tenants: total, active_tenants: active, suspended_count: items.length - active });
});
