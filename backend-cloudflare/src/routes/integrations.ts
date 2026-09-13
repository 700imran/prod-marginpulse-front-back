import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { listIntegrations, getIntegration, upsertIntegration, disconnectIntegration, markIntegrationSynced } from "../repository/integrations";
import { bulkInsertBankTransactions } from "../repository/bankTransactions";
import { encryptField, decryptField } from "../security/fieldEncryption";
import { RazorpayConnector } from "../integrations/razorpay";
import { StripeConnector } from "../integrations/stripe";
import { slackAuthUrl, slackExchangeCode } from "../integrations/slack";
import { storeOAuthState, consumeOAuthState } from "../ratelimit";
import type { DataConnector } from "../integrations/connector";

export const integrationRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

// Providers whose credentials need more than one named field, and
// therefore go in credentials_encrypted (JSON blob) instead of
// api_key_encrypted (single opaque value). See the comment in the
// /connect handler below.
const MULTI_FIELD_CREDENTIAL_PROVIDERS = new Set(["RAZORPAY"]);

function dataConnectorFor(provider: string): DataConnector | null {
  switch (provider.toUpperCase()) {
    case "RAZORPAY": return new RazorpayConnector();
    case "STRIPE": return new StripeConnector();
    default: return null; // PayPal, Square, Notion, QuickBooks, etc. — see integrations/connector.ts's header comment
  }
}

integrationRoutes.get("/", requireAuth, async (c) => c.json({ items: await listIntegrations(c.get("sql"), c.get("tenant").tenantId) }));

integrationRoutes.post("/:provider/connect", requireAuth, async (c) => {
  const provider = c.req.param("provider").toUpperCase();
  const connector = dataConnectorFor(provider);
  if (!connector) return c.json({ error: `${provider} is not yet implemented — see src/integrations/connector.ts for what's needed to add it` }, 501);

  const { credentials } = await c.req.json();
  let externalAccountId: string, externalAccountName: string;
  try {
    ({ externalAccountId, externalAccountName } = await connector.connect(credentials ?? {}));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }

  // Multi-field providers (Razorpay: key_id + key_secret) store the
  // whole credentials object as one encrypted JSON blob in
  // credentials_encrypted, so sync can decrypt-and-parse it back into
  // named fields. This replaces the old approach of concatenating
  // encrypted values into api_key_encrypted, which worked for
  // connecting but couldn't be split back apart for sync — that was
  // the specific limitation blocking Razorpay sync (see NEXT_STEPS.md
  // history). Single-field providers (Stripe's lone secret_key) keep
  // using api_key_encrypted; no behavior change for them.
  const tenantId = c.get("tenant").tenantId;
  let apiKeyEncrypted: string | undefined;
  let credentialsEncrypted: string | undefined;
  if (MULTI_FIELD_CREDENTIAL_PROVIDERS.has(provider)) {
    credentialsEncrypted = await encryptField(c.env, JSON.stringify(credentials ?? {}));
  } else {
    const encryptedParts = await Promise.all(Object.values(credentials ?? {}).map((v) => encryptField(c.env, String(v))));
    apiKeyEncrypted = encryptedParts.join("");
  }

  await upsertIntegration(c.get("sql"), { tenantId, provider, status: "CONNECTED", apiKeyEncrypted, credentialsEncrypted, externalAccountId, externalAccountName });
  const saved = await getIntegration(c.get("sql"), tenantId, provider);
  return c.json(saved, 201);
});

integrationRoutes.post("/:provider/sync", requireAuth, async (c) => {
  const provider = c.req.param("provider").toUpperCase();
  const connector = dataConnectorFor(provider);
  if (!connector) return c.json({ error: `${provider} does not support data sync` }, 501);

  const tenantId = c.get("tenant").tenantId;
  const existing = await getIntegration(c.get("sql"), tenantId, provider);
  if (!existing) return c.json({ error: `${provider} is not connected` }, 404);

  const credentials: Record<string, string> = {};
  if (provider === "STRIPE" && existing.apiKeyEncrypted) {
    credentials.secret_key = await decryptField(c.env, existing.apiKeyEncrypted);
  } else if (MULTI_FIELD_CREDENTIAL_PROVIDERS.has(provider) && existing.credentialsEncrypted) {
    const decrypted = await decryptField(c.env, existing.credentialsEncrypted);
    Object.assign(credentials, JSON.parse(decrypted) as Record<string, string>);
  } else if (MULTI_FIELD_CREDENTIAL_PROVIDERS.has(provider)) {
    return c.json({ error: `${provider} is connected but has no stored credentials — reconnect it` }, 409);
  }

  let txns;
  try {
    txns = await connector.fetchTransactions(credentials, "");
  } catch (e) {
    await upsertIntegration(c.get("sql"), { tenantId, provider, status: "ERROR", lastError: (e as Error).message });
    return c.json({ error: `Sync failed: ${(e as Error).message}` }, 502);
  }

  const created = await bulkInsertBankTransactions(c.get("sql"), txns.map((t) => ({
    tenantId, narration: t.narration, transactionDate: t.date, debitAmount: 0, creditAmount: t.amount, bankName: provider,
  })));
  await markIntegrationSynced(c.get("sql"), tenantId, provider);

  return c.json({ transactions_synced: created, found: txns.length });
});

integrationRoutes.post("/:provider/disconnect", requireAuth, async (c) => {
  await disconnectIntegration(c.get("sql"), c.get("tenant").tenantId, c.req.param("provider").toUpperCase());
  return c.body(null, 204);
});

// --- Slack OAuth connect (separate from the API-key flow above) ----------

integrationRoutes.get("/slack/connect", requireAuth, async (c) => {
  const tenant = c.get("tenant");
  const state = crypto.randomUUID();
  await storeOAuthState(c.env, state, tenant.tenantId);
  const url = await slackAuthUrl(c.get("sql"), state);
  return c.redirect(url, 302);
});

// Unauthenticated — Slack redirects the user's browser here directly,
// so the tenant is recovered from the state token instead of a Bearer
// token (needs its own withDb since it sits outside the requireAuth
// chain — wired up in src/index.ts).
integrationRoutes.get("/slack/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const tenantId = await consumeOAuthState(c.env, state);
  if (!tenantId) return c.redirect(`${c.env.FRONTEND_ORIGIN}/?integration=slack&status=error&reason=invalid_state`, 302);

  try {
    const { accessToken, teamName, incomingWebhookUrl } = await slackExchangeCode(c.env, c.get("sql"), code);
    const [accessTokenEncrypted, apiKeyEncrypted] = await Promise.all([
      encryptField(c.env, accessToken),
      encryptField(c.env, incomingWebhookUrl),
    ]);
    await upsertIntegration(c.get("sql"), { tenantId, provider: "SLACK", status: "CONNECTED", accessTokenEncrypted, apiKeyEncrypted, externalAccountName: teamName });
    return c.redirect(`${c.env.FRONTEND_ORIGIN}/?integration=slack&status=connected`, 302);
  } catch (e) {
    return c.redirect(`${c.env.FRONTEND_ORIGIN}/?integration=slack&status=error`, 302);
  }
});
