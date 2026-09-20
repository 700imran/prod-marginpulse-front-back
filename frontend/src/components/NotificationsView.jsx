/**
 * NotificationsView.jsx — real load/save against
 * GET/PATCH /api/v1/settings/notifications.
 */
import { useState, useEffect } from "react";
import { getNotificationSettings, updateNotificationSettings } from "../api";
import { Toggle } from "../theme";

export default function NotificationsView({ onToast }) {
  const [settings, setSettings] = useState(null);
  const [threshold, setThreshold] = useState(10000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getNotificationSettings().then((data) => {
      if (data) {
        setSettings(data);
        setThreshold(data.criticalItcThresholdInr);
      }
      setLoading(false);
    });
  }, []);

  async function patch(fields) {
    setSaving(true);
    const updated = await updateNotificationSettings(fields);
    if (updated?.weeklyAuditSummary !== undefined) {
      setSettings(updated);
      onToast?.("Notification preferences updated", "success");
    } else {
      onToast?.(updated?.detail || "Could not save", "error");
    }
    setSaving(false);
  }

  function handleThresholdBlur() {
    const num = Math.max(0, parseFloat(threshold) || 0);
    setThreshold(num);
    patch({ criticalItcThresholdInr: num });
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;

  return (
    <div className="card">
      <h3 style={{ marginBottom: 24, fontSize: 18 }}>Alert Preferences</h3>
      <Toggle
        title="Critical ITC Missing"
        desc={`Email admin immediately if a vendor fails to file GSTR-1 exceeding ₹${Number(threshold).toLocaleString("en-IN")}.`}
        checked={settings?.criticalItcMissingAlert}
        onChange={(v) => { setSettings((s) => ({ ...s, criticalItcMissingAlert: v })); patch({ criticalItcMissingAlert: v }); }}
        disabled={saving}
      />
      <div className="form-group" style={{ marginTop: 8, marginBottom: 8, maxWidth: 300 }}>
        <label className="form-label">ITC Alert Threshold (₹)</label>
        <input
          type="number"
          className="form-control"
          value={threshold}
          min={0}
          onChange={(e) => setThreshold(e.target.value)}
          onBlur={handleThresholdBlur}
        />
      </div>
      <Toggle
        title="Weekly Audit Summary"
        desc="Receive a summary of all flagged variances and matched records every Friday."
        checked={settings?.weeklyAuditSummary}
        onChange={(v) => { setSettings((s) => ({ ...s, weeklyAuditSummary: v })); patch({ weeklyAuditSummary: v }); }}
        disabled={saving}
      />
    </div>
  );
}
