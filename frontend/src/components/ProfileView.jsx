/**
 * ProfileView.jsx — "Profile Configurations" page. Real load/save against
 * GET/PATCH /api/v1/auth/me. Replaces the mockup's defaultValue-only inputs.
 */
import { useState, useEffect } from "react";
import { getProfile, updateProfile } from "../api";

export default function ProfileView({ onToast, onProfileUpdated }) {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ display_name: "", business_name: "", phone_number: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getProfile().then((data) => {
      if (!active || !data) return;
      setProfile(data);
      setForm({
        display_name: data.display_name || "",
        business_name: data.business_name || "",
        phone_number: data.phone_number || "",
      });
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { active = false; };
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const updated = await updateProfile({
        display_name: form.display_name || null,
        business_name: form.business_name,
        phone_number: form.phone_number || null,
      });
      if (updated?.tenant_id) {
        setProfile(updated);
        onToast?.("Profile saved", "success");
        onProfileUpdated?.(updated);
      } else {
        setError(updated?.detail || "Could not save changes");
      }
    } catch {
      setError("Network error — could not save changes");
    }
    setSaving(false);
  }

  if (loading) {
    return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading profile…</p></div>;
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: 24, fontSize: 18 }}>Workspace Details</h3>
      <div className="grid-2">
        <div className="form-group">
          <label className="form-label">Professional Name</label>
          <input
            type="text"
            className="form-control"
            value={form.display_name}
            onChange={set("display_name")}
            placeholder="e.g. CA. Imran Kathat"
            maxLength={255}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Email Address</label>
          <input type="email" className="form-control" value={profile?.owner_email || ""} disabled />
        </div>
        <div className="form-group">
          <label className="form-label">Firm / Workspace Name</label>
          <input
            type="text"
            className="form-control"
            value={form.business_name}
            onChange={set("business_name")}
            maxLength={255}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label">Contact Phone</label>
          <input
            type="text"
            className="form-control"
            value={form.phone_number}
            onChange={set("phone_number")}
            placeholder="+919876543210"
            maxLength={20}
          />
        </div>
      </div>
      {error && <div className="inline-error" style={{ marginBottom: 16 }}>{error}</div>}
      <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save Profile Changes"}
      </button>
      <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 16 }}>
        Manage your GSTIN, PAN, and bank account links under <strong>Tax IDs & Bank Accounts</strong>.
      </p>
    </div>
  );
}
