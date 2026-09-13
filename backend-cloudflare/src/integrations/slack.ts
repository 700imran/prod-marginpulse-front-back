import type { Env } from "../config";
import type { Sql } from "../db";
import { getSlackAppConfig } from "../repository/platformSettings";
import { decryptField } from "../security/fieldEncryption";

// Exact port of internal/integrations/slack.go — Slack's real OAuth v2 +
// "Incoming Webhooks" feature, used to push reconciliation alerts into a
// tenant's chosen Slack channel. Not a DataConnector (Slack doesn't hold
// financial records to pull) — this only sends notifications out.
//
// Slack app credentials live in platform_settings (admin-configurable at
// runtime), same as the Go original — not a wrangler secret, since an
// admin should be able to rotate the Slack app without a redeploy.

export async function slackAuthUrl(sql: Sql, state: string): Promise<string> {
  const settings = await getSlackAppConfig(sql);
  if (!settings.slackClientId || !settings.slackRedirectUri) {
    throw new Error("Slack integration is not configured — set client id/secret in platform settings first");
  }
  const params = new URLSearchParams({
    client_id: settings.slackClientId,
    scope: "incoming-webhook",
    redirect_uri: settings.slackRedirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function slackExchangeCode(env: Env, sql: Sql, code: string): Promise<{ accessToken: string; teamName: string; incomingWebhookUrl: string }> {
  const settings = await getSlackAppConfig(sql);
  if (!settings.slackClientId || !settings.slackClientSecretEncrypted || !settings.slackRedirectUri) {
    throw new Error("Slack integration is not configured");
  }
  const clientSecret = await decryptField(env, settings.slackClientSecretEncrypted);

  const form = new URLSearchParams({
    client_id: settings.slackClientId,
    client_secret: clientSecret,
    code,
    redirect_uri: settings.slackRedirectUri,
  });
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await resp.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    team?: { name: string };
    incoming_webhook?: { url: string; channel: string };
  };
  if (!body.ok) throw new Error(`slack oauth failed: ${body.error}`);
  return {
    accessToken: body.access_token!,
    teamName: body.team?.name ?? "",
    incomingWebhookUrl: body.incoming_webhook?.url ?? "",
  };
}

export async function slackSendNotification(webhookUrl: string, message: string): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  if (!resp.ok) throw new Error(`slack webhook send failed: HTTP ${resp.status}`);
}
