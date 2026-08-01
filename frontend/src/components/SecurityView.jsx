/**
 * SecurityView.jsx — real password change against
 * POST /api/v1/auth/change-password. Session list is honest about what
 * the backend can currently report: there is no multi-session tracking
 * table yet (the backend tracks individual token revocation, not a
 * named list of "this device, that device"), so rather than fabricate a
 * fake device list, this clearly states what changing the password
 * actually does — invalidates the current session and requires
 * re-login — instead of pretending to show real session metadata that
 * doesn't exist.
 */
import { useState } from "react";
import { changePassword, logout } from "../api";

export default function SecurityView({ onToast }) {
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleChangePassword(e) {
    e.preventDefault();
    setError("");
    if (form.next !== form.confirm) {
      setError("New password and confirmation do not match");
      return;
    }
    if (form.next.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    setSubmitting(true);
    const result = await changePassword(form.current, form.next);
    setSubmitting(false);
    if (result?.detail?.toLowerCase().includes("successfully")) {
      onToast?.("Password changed — please log in again", "success");
      setTimeout(() => logout(), 1500);
    } else {
      setError(result?.detail || "Could not change password");
    }
  }

  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 24, fontSize: 18 }}>Change Password</h3>
        <form onSubmit={handleChangePassword}>
          <div className="form-group">
            <label className="form-label">Current Password</label>
            <input type="password" className="form-control" value={form.current} onChange={set("current")} maxLength={128} required />
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">New Password</label>
              <input type="password" className="form-control" value={form.next} onChange={set("next")} minLength={8} maxLength={128} required />
            </div>
            <div className="form-group">
              <label className="form-label">Confirm New Password</label>
              <input type="password" className="form-control" value={form.confirm} onChange={set("confirm")} minLength={8} maxLength={128} required />
            </div>
          </div>
          {error && <div className="inline-error" style={{ marginBottom: 16 }}>{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Changing…" : "Change Password"}
          </button>
          <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 12 }}>
            Changing your password ends your current session — you'll need to log in again afterward.
          </p>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16, fontSize: 18 }}>Current Session</h3>
        <div style={{ padding: "12px 0" }}>
          <p style={{ color: "var(--text-gray)", fontSize: 13, lineHeight: 1.6 }}>
            You're currently signed in. Tokens are individually revocable —
            logging out or changing your password immediately invalidates
            this session server-side (not just locally), so a stolen token
            stops working the moment you log out.
          </p>
        </div>
        <button
          className="btn btn-danger-ghost"
          style={{ marginTop: 12 }}
          onClick={() => logout()}
        >
          Log out of this session
        </button>
      </div>
    </>
  );
}
