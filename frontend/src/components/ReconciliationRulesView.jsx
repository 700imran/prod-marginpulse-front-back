/**
 * ReconciliationRulesView.jsx — real load/save against
 * GET/PATCH /api/v1/settings/reconciliation.
 */
import { useState, useEffect } from "react";
import { getReconciliationSettings, updateReconciliationSettings } from "../api";
import { Toggle } from "../theme";

export default function ReconciliationRulesView({ onToast }) {
  const [settings, setSettings] = useState(null);
  const [threshold, setThreshold] = useState(95);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getReconciliationSettings().then((data) => {
      if (data) {
        setSettings(data);
        setThreshold(data.ocr_confidence_threshold);
      }
      setLoading(false);
    });
  }, []);

  async function patch(fields) {
    setSaving(true);
    const updated = await updateReconciliationSettings(fields);
    if (updated?.ocr_confidence_threshold !== undefined) {
      setSettings(updated);
      onToast?.("Reconciliation rules updated", "success");
    } else {
      onToast?.(updated?.detail || "Could not save", "error");
    }
    setSaving(false);
  }

  function handleThresholdBlur() {
    const num = Math.max(0, Math.min(100, parseInt(threshold, 10) || 0));
    setThreshold(num);
    patch({ ocr_confidence_threshold: num });
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;

  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 24, fontSize: 18 }}>AI Matching Parameters</h3>
        <Toggle
          title="Fuzzy Vendor Matching"
          desc="Allow AI to match variations of names (e.g., 'TechServe' and 'TechServe Pvt Ltd')."
          checked={settings?.fuzzy_vendor_matching}
          onChange={(v) => { setSettings((s) => ({ ...s, fuzzy_vendor_matching: v })); patch({ fuzzy_vendor_matching: v }); }}
          disabled={saving}
        />
        <Toggle
          title="Date Drift Tolerance"
          desc="Allow matching if bank settlement date is within ±5 days of invoice date."
          checked={settings?.date_drift_tolerance}
          onChange={(v) => { setSettings((s) => ({ ...s, date_drift_tolerance: v })); patch({ date_drift_tolerance: v }); }}
          disabled={saving}
        />
        <div className="form-group" style={{ marginTop: 24, maxWidth: 300 }}>
          <label className="form-label">OCR Confidence Threshold (%)</label>
          <input
            type="number"
            className="form-control"
            value={threshold}
            min={0}
            max={100}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={handleThresholdBlur}
          />
          <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 8 }}>
            Require manual review if document extraction score is below this.
          </p>
        </div>
      </div>
      <div className="card pro-block">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h3 style={{ fontSize: 18 }}>Multi-currency Reconciliation</h3>
          <span className="nav-badge badge-pro" style={{ padding: "4px 8px" }}>Pro Feature</span>
        </div>
        <p style={{ color: "var(--text-gray)", marginTop: 10 }}>
          Auto-calculate forex variance based on historical settlement dates.
        </p>
      </div>
    </>
  );
}
