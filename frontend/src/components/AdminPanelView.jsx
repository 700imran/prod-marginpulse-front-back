/**
 * AdminPanelView.jsx — Platform admin panel, only reachable when
 * tenant.is_platform_admin is true (see App.jsx's conditional nav
 * section and the backend's RequirePlatformAdmin middleware, which is
 * the REAL security boundary — this component being unreachable in the
 * UI is a convenience, not the access control).
 *
 * Three tabs:
 *  - Platform Settings: OAuth/integration provider credentials + global
 *    feature-flag kill switches, editable without a backend redeploy.
 *  - Tenants: every customer account, with suspend/reactivate.
 *  - System Stats: basic counts derived from DynamoDB.
 */
import { useState, useEffect } from "react";
import {
  getPlatformSettings, updatePlatformSettings,
  listAllTenants, setTenantActive, getSystemStats,
} from "../api";
import { Toggle } from "../theme";

const TABS = [
  { id: "settings", label: "Platform Settings" },
  { id: "tenants", label: "Tenants" },
  { id: "stats", label: "System Stats" },
];

function SecretField({ label, value, onChange, placeholder }) {
  const [revealed, setRevealed] = useState(false);
  const isMasked = value === "••••••••";
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-gray)", marginBottom: 6 }}>{label}</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="form-control"
          type={revealed ? "text" : "password"}
          placeholder={isMasked ? "Already set — enter a new value to change it" : placeholder}
          value={isMasked && !revealed ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-ghost" onClick={() => setRevealed((r) => !r)}>
          {revealed ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-gray)", marginBottom: 6 }}>{label}</label>
      <input className="form-control" value={value || ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function PlatformSettingsTab({ onToast }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPlatformSettings().then((data) => { if (data) setSettings(data); setLoading(false); });
  }, []);

  function set(field, value) {
    setSettings((s) => ({ ...s, [field]: value }));
  }

  async function save() {
    setSaving(true);
    const result = await updatePlatformSettings(settings);
    setSaving(false);
    if (result?.updated_at) {
      setSettings(result);
      onToast?.("Platform settings saved", "success");
    } else {
      onToast?.(result?.detail || "Save failed", "error");
    }
  }

  if (loading) return <p style={{ color: "var(--text-gray)" }}>Loading…</p>;

  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4, fontSize: 16 }}>Google Sign-In</h3>
        <p style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 16 }}>
          From Google Cloud Console → APIs &amp; Credentials → OAuth Client ID.
        </p>
        <TextField label="Client ID" value={settings.google_client_id} onChange={(v) => set("google_client_id", v)} placeholder="xxxx.apps.googleusercontent.com" />
        <SecretField label="Client Secret" value={settings.google_client_secret} onChange={(v) => set("google_client_secret", v)} placeholder="GOCSPX-..." />
        <TextField label="Redirect URI" value={settings.google_redirect_uri} onChange={(v) => set("google_redirect_uri", v)} placeholder="https://api.yourapp.com/api/v1/auth/google/callback" />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4, fontSize: 16 }}>Apple Sign-In</h3>
        <p style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 16 }}>
          Requires an active Apple Developer Program membership and a Sign in with Apple key (.p8 file).
        </p>
        <TextField label="Services ID (Client ID)" value={settings.apple_client_id} onChange={(v) => set("apple_client_id", v)} placeholder="com.marginpulse.web" />
        <TextField label="Team ID" value={settings.apple_team_id} onChange={(v) => set("apple_team_id", v)} />
        <TextField label="Key ID" value={settings.apple_key_id} onChange={(v) => set("apple_key_id", v)} />
        <SecretField label="Private Key (.p8 contents)" value={settings.apple_private_key} onChange={(v) => set("apple_private_key", v)} placeholder="-----BEGIN PRIVATE KEY-----..." />
        <TextField label="Redirect URI" value={settings.apple_redirect_uri} onChange={(v) => set("apple_redirect_uri", v)} placeholder="https://api.yourapp.com/api/v1/auth/apple/callback" />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4, fontSize: 16 }}>Slack</h3>
        <p style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 16 }}>
          From api.slack.com/apps → your app → OAuth &amp; Permissions.
        </p>
        <TextField label="Client ID" value={settings.slack_client_id} onChange={(v) => set("slack_client_id", v)} />
        <SecretField label="Client Secret" value={settings.slack_client_secret} onChange={(v) => set("slack_client_secret", v)} />
        <TextField label="Redirect URI" value={settings.slack_redirect_uri} onChange={(v) => set("slack_redirect_uri", v)} placeholder="https://api.yourapp.com/api/v1/integrations/slack/callback" />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 16, fontSize: 16 }}>Global Feature Flags</h3>
        <p style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 16 }}>
          Kill switches — turn a feature OFF for every tenant at once without a deploy (e.g. during a provider outage).
        </p>
        <Toggle title="AI Insights" desc="Dashboard's plain-English AI summary (falls back to rule-based text when off)." checked={settings.ai_insights_enabled ?? true} onChange={(v) => set("ai_insights_enabled", v)} />
        <Toggle title="WhatsApp Ingest" desc="Accept documents sent in via WhatsApp." checked={settings.whatsapp_ingest_enabled ?? true} onChange={(v) => set("whatsapp_ingest_enabled", v)} />
        <Toggle title="Email Ingest" desc="Accept documents sent in via email." checked={settings.email_ingest_enabled ?? true} onChange={(v) => set("email_ingest_enabled", v)} />
        <Toggle title="Razorpay Integration" desc="Allow tenants to connect Razorpay." checked={settings.razorpay_integration_enabled ?? true} onChange={(v) => set("razorpay_integration_enabled", v)} />
        <Toggle title="Stripe Integration" desc="Allow tenants to connect Stripe." checked={settings.stripe_integration_enabled ?? true} onChange={(v) => set("stripe_integration_enabled", v)} />
        <Toggle title="Slack Integration" desc="Allow tenants to connect Slack." checked={settings.slack_integration_enabled ?? true} onChange={(v) => set("slack_integration_enabled", v)} />
        <Toggle title="New Signups" desc="Allow new accounts to register (turn off to pause growth temporarily)." checked={settings.new_signups_enabled ?? true} onChange={(v) => set("new_signups_enabled", v)} />
      </div>

      <button className="btn btn-primary" onClick={save} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save Platform Settings"}
      </button>
      {settings.updated_at && (
        <p style={{ fontSize: 11, color: "var(--text-gray)", marginTop: 10, textAlign: "center" }}>
          Last updated {new Date(settings.updated_at).toLocaleString()} by {settings.updated_by}
        </p>
      )}
    </>
  );
}

function TenantsTab({ onToast }) {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const result = await listAllTenants();
    setTenants(result?.items || []);
    setLoading(false);
  }

  useEffect(() => { refresh(); }, []);

  async function toggleActive(tenantId, current) {
    const result = await setTenantActive(tenantId, !current);
    if (result?.tenant_id) {
      onToast?.(`Tenant ${!current ? "reactivated" : "suspended"}`, "success");
      refresh();
    } else {
      onToast?.(result?.detail || "Update failed", "error");
    }
  }

  if (loading) return <p style={{ color: "var(--text-gray)" }}>Loading…</p>;

  return (
    <div className="card">
      <h3 style={{ marginBottom: 16, fontSize: 16 }}>All Tenants ({tenants.length})</h3>
      {tenants.map((t) => (
        <div className="list-row" key={t.tenant_id}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {t.business_name} {t.is_platform_admin && <span style={{ fontSize: 10, color: "var(--primary-color)", marginLeft: 6 }}>ADMIN</span>}
            </div>
            <p style={{ fontSize: 12, color: "var(--text-gray)" }}>
              {t.owner_email} · {t.plan_tier} · joined {new Date(t.created_at).toLocaleDateString()}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: t.is_active ? "var(--primary-color)" : "var(--danger-color)" }}>
              {t.is_active ? "● Active" : "● Suspended"}
            </span>
            <button className="btn btn-ghost" onClick={() => toggleActive(t.tenant_id, t.is_active)}>
              {t.is_active ? "Suspend" : "Reactivate"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState(null);

  useEffect(() => { getSystemStats().then((data) => { if (data) setStats(data); }); }, []);

  if (!stats) return <p style={{ color: "var(--text-gray)" }}>Loading…</p>;

  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <div className="card" style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontSize: 30, fontWeight: 800 }}>{stats.total_tenants}</div>
        <div style={{ fontSize: 13, color: "var(--text-gray)" }}>Total Tenants</div>
      </div>
      <div className="card" style={{ flex: 1, minWidth: 180, borderTop: "3px solid var(--primary-color)" }}>
        <div style={{ fontSize: 30, fontWeight: 800 }}>{stats.active_tenants}</div>
        <div style={{ fontSize: 13, color: "var(--text-gray)" }}>Active</div>
      </div>
      <div className="card" style={{ flex: 1, minWidth: 180, borderTop: "3px solid var(--danger-color)" }}>
        <div style={{ fontSize: 30, fontWeight: 800 }}>{stats.suspended_count}</div>
        <div style={{ fontSize: 13, color: "var(--text-gray)" }}>Suspended</div>
      </div>
      <div className="card" style={{ width: "100%", marginTop: 8 }}>
        <p style={{ fontSize: 13, color: "var(--text-gray)" }}>
          For error rates, latency, and DLQ depth, see the CloudWatch dashboards described in
          MONITORING.md — those live metrics don't come from this database and aren't duplicated here.
        </p>
      </div>
    </div>
  );
}

export default function AdminPanelView({ onToast }) {
  const [tab, setTab] = useState("settings");

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`btn ${tab === t.id ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "settings" && <PlatformSettingsTab onToast={onToast} />}
      {tab === "tenants" && <TenantsTab onToast={onToast} />}
      {tab === "stats" && <StatsTab />}
    </>
  );
}
