/**
 * IntegrationsView.jsx — GST/WhatsApp settings toggles (existing) plus
 * the payment gateway & business tool connector hub (new): Razorpay and
 * Stripe (API-key based, fully working against real APIs), Slack
 * (OAuth, fully working), and clearly-marked "coming soon" cards for
 * providers the backend doesn't implement yet — see
 * internal/integrations/stub.go in the backend repo for what's needed
 * to light each of those up.
 */
import { useState, useEffect } from "react";
import {
  getIntegrationSettings, updateIntegrationSettings,
  listIntegrations, connectIntegration, syncIntegration, disconnectIntegration, getSlackConnectUrl,
} from "../api";
import { Toggle } from "../theme";

const CONNECTED_STATUS_COLOR = "var(--primary-color)";
const ERROR_STATUS_COLOR = "var(--danger-color)";

function ProviderCard({ title, logo, description, integration, children, onSync, onDisconnect, syncing }) {
  const connected = integration?.status === "CONNECTED";
  const errored = integration?.status === "ERROR";

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ fontSize: 24 }}>{logo}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
            <p style={{ fontSize: 12, color: "var(--text-gray)", margin: 0 }}>{description}</p>
          </div>
        </div>
        {connected && (
          <span style={{ fontSize: 11, fontWeight: 700, color: CONNECTED_STATUS_COLOR, background: "var(--primary-light)", padding: "4px 10px", borderRadius: 20 }}>
            ● Connected
          </span>
        )}
        {errored && (
          <span style={{ fontSize: 11, fontWeight: 700, color: ERROR_STATUS_COLOR, padding: "4px 10px" }}>
            ● Error
          </span>
        )}
      </div>

      {connected ? (
        <div>
          {integration.external_account_name && (
            <p style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 10 }}>
              Account: <strong>{integration.external_account_name}</strong>
              {integration.last_synced_at && ` · Last synced ${new Date(integration.last_synced_at).toLocaleString()}`}
            </p>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            {onSync && (
              <button className="btn btn-primary" onClick={onSync} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync Now"}
              </button>
            )}
            <button className="btn btn-ghost" onClick={onDisconnect}>Disconnect</button>
          </div>
          {errored && integration.last_error && (
            <p style={{ fontSize: 12, color: ERROR_STATUS_COLOR, marginTop: 8 }}>{integration.last_error}</p>
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function RazorpayCard({ integration, onChanged, onToast }) {
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function handleConnect() {
    if (!keyId || !keySecret) { onToast?.("Enter both Key ID and Key Secret", "error"); return; }
    setConnecting(true);
    const result = await connectIntegration("razorpay", { key_id: keyId, key_secret: keySecret });
    setConnecting(false);
    if (result?.provider) {
      onToast?.("Razorpay connected", "success");
      setKeyId(""); setKeySecret("");
      onChanged();
    } else {
      onToast?.(result?.detail || "Connection failed — check your API keys", "error");
    }
  }

  async function handleSync() {
    setSyncing(true);
    const result = await syncIntegration("razorpay");
    setSyncing(false);
    if (result?.transactions_synced !== undefined) {
      onToast?.(`Synced ${result.transactions_synced} settlements`, "success");
    } else {
      onToast?.(result?.detail || "Sync failed", "error");
    }
  }

  async function handleDisconnect() {
    await disconnectIntegration("razorpay");
    onToast?.("Razorpay disconnected", "success");
    onChanged();
  }

  return (
    <ProviderCard
      title="Razorpay" logo="💳"
      description="Auto-import settlement deposits so bulk payouts match against individual invoices."
      integration={integration} onSync={handleSync} onDisconnect={handleDisconnect} syncing={syncing}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input className="form-control" placeholder="Key ID (rzp_live_...)" value={keyId} onChange={(e) => setKeyId(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <input className="form-control" type="password" placeholder="Key Secret" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn btn-primary" onClick={handleConnect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-gray)", marginTop: 8 }}>
        Find these under Razorpay Dashboard → Settings → API Keys.
      </p>
    </ProviderCard>
  );
}

function StripeCard({ integration, onChanged, onToast }) {
  const [secretKey, setSecretKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function handleConnect() {
    if (!secretKey) { onToast?.("Enter your Stripe secret key", "error"); return; }
    setConnecting(true);
    const result = await connectIntegration("stripe", { secret_key: secretKey });
    setConnecting(false);
    if (result?.provider) {
      onToast?.("Stripe connected", "success");
      setSecretKey("");
      onChanged();
    } else {
      onToast?.(result?.detail || "Connection failed — check your secret key", "error");
    }
  }

  async function handleSync() {
    setSyncing(true);
    const result = await syncIntegration("stripe");
    setSyncing(false);
    if (result?.transactions_synced !== undefined) {
      onToast?.(`Synced ${result.transactions_synced} payouts`, "success");
    } else {
      onToast?.(result?.detail || "Sync failed", "error");
    }
  }

  async function handleDisconnect() {
    await disconnectIntegration("stripe");
    onToast?.("Stripe disconnected", "success");
    onChanged();
  }

  return (
    <ProviderCard
      title="Stripe" logo="🌐"
      description="Import cross-border payouts for international transaction reconciliation."
      integration={integration} onSync={handleSync} onDisconnect={handleDisconnect} syncing={syncing}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input className="form-control" type="password" placeholder="Secret Key (sk_live_...)" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn btn-primary" onClick={handleConnect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-gray)", marginTop: 8 }}>
        Find this under Stripe Dashboard → Developers → API Keys. Read-only access is sufficient.
      </p>
    </ProviderCard>
  );
}

function SlackCard({ integration, onChanged, onToast }) {
  async function handleDisconnect() {
    await disconnectIntegration("slack");
    onToast?.("Slack disconnected", "success");
    onChanged();
  }

  return (
    <ProviderCard
      title="Slack" logo="💬"
      description="Get reconciliation alerts (new GST mismatches, unmatched payments) posted to a channel."
      integration={integration} onDisconnect={handleDisconnect}
    >
      <a className="btn btn-primary" href={getSlackConnectUrl()} style={{ display: "inline-block", textDecoration: "none" }}>
        Connect to Slack
      </a>
    </ProviderCard>
  );
}

function ComingSoonCard({ title, logo, description }) {
  return (
    <div className="card" style={{ marginBottom: 16, opacity: 0.55 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ fontSize: 24 }}>{logo}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
            <p style={{ fontSize: 12, color: "var(--text-gray)", margin: 0 }}>{description}</p>
          </div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-gray)", background: "#f1f5f9", padding: "4px 10px", borderRadius: 20 }}>
          Coming soon
        </span>
      </div>
    </div>
  );
}

export default function IntegrationsView({ onToast }) {
  const [settings, setSettings] = useState(null);
  const [integrations, setIntegrations] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function refreshIntegrations() {
    const result = await listIntegrations();
    const byProvider = {};
    (result?.items || []).forEach((it) => { byProvider[it.provider] = it; });
    setIntegrations(byProvider);
  }

  useEffect(() => {
    Promise.all([getIntegrationSettings(), listIntegrations()]).then(([settingsData, integrationsData]) => {
      if (settingsData) setSettings(settingsData);
      const byProvider = {};
      (integrationsData?.items || []).forEach((it) => { byProvider[it.provider] = it; });
      setIntegrations(byProvider);
      setLoading(false);
    });
  }, []);

  async function patch(fields) {
    setSaving(true);
    const updated = await updateIntegrationSettings(fields);
    if (updated?.gst_auto_sync_enabled !== undefined) {
      setSettings(updated);
      onToast?.("Integration settings updated", "success");
    } else {
      onToast?.(updated?.detail || "Could not save", "error");
    }
    setSaving(false);
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;

  return (
    <>
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 24, fontSize: 18 }}>GST & WhatsApp</h3>
        <Toggle
          title="GST Portal Auto-Sync"
          desc={`Fetch GSTR-2B JSON data automatically on day ${settings?.gst_auto_sync_day_of_month || 14} of every month.`}
          checked={settings?.gst_auto_sync_enabled}
          onChange={(v) => { setSettings((s) => ({ ...s, gst_auto_sync_enabled: v })); patch({ gst_auto_sync_enabled: v }); }}
          disabled={saving}
        />
        <Toggle
          title="WhatsApp API Integration"
          desc="Allow MarginPulse to draft and send ITC reminders directly via WhatsApp Business."
          checked={settings?.whatsapp_outbound_enabled}
          onChange={(v) => { setSettings((s) => ({ ...s, whatsapp_outbound_enabled: v })); patch({ whatsapp_outbound_enabled: v }); }}
          disabled={saving}
        />
      </div>

      <h3 style={{ marginBottom: 16, fontSize: 18 }}>Payment Gateways</h3>
      <RazorpayCard integration={integrations.RAZORPAY} onChanged={refreshIntegrations} onToast={onToast} />
      <StripeCard integration={integrations.STRIPE} onChanged={refreshIntegrations} onToast={onToast} />
      <ComingSoonCard title="PayPal" logo="🅿️" description="Payouts and cross-border settlement import." />
      <ComingSoonCard title="Square" logo="◻️" description="In-person and online payment reconciliation." />

      <h3 style={{ margin: "24px 0 16px" }}>Business Tools</h3>
      <SlackCard integration={integrations.SLACK} onChanged={refreshIntegrations} onToast={onToast} />
      <ComingSoonCard title="Notion" logo="📝" description="Sync reconciliation summaries to a Notion workspace." />
      <ComingSoonCard title="QuickBooks Online" logo="📊" description="Pull accounts receivable/payable and tax ledgers." />
      <ComingSoonCard title="Xero" logo="📗" description="Pull accounts receivable/payable and tax ledgers." />
    </>
  );
}
