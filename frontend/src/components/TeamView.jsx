/**
 * TeamView.jsx — real invite/list/revoke against /api/v1/team/*.
 * Sends an actual email with an invite link (via the backend's SMTP
 * service); does not yet implement the invitee accepting and getting
 * their own login — see team_member.py model docstring for why that's
 * intentionally a separate, later piece of work.
 */
import { useState, useEffect } from "react";
import { listTeamMembers, inviteTeamMember, revokeTeamMember } from "../api";

const ROLE_OPTIONS = [
  { value: "VIEWER", label: "Viewer" },
  { value: "ACCOUNTANT", label: "Accountant" },
  { value: "ADMIN", label: "Admin" },
];

function statusBadge(status) {
  const map = {
    PENDING: { cls: "badge-pending", label: "Pending" },
    ACTIVE: { cls: "badge-verified", label: "Active" },
    REVOKED: { cls: "badge-failed", label: "Revoked" },
  };
  const s = map[status] || map.PENDING;
  return <span className={`badge-pill ${s.cls}`}>{s.label}</span>;
}

export default function TeamView({ onToast }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ email: "", role: "VIEWER" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listTeamMembers().then((data) => {
      if (Array.isArray(data)) setMembers(data);
      setLoading(false);
    });
  }, []);

  async function handleInvite(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    const result = await inviteTeamMember(form.email.trim(), form.role);
    if (result?.team_member_id) {
      setMembers((prev) => [result, ...prev]);
      setForm({ email: "", role: "VIEWER" });
      onToast?.("Invitation sent", "success");
    } else {
      setError(result?.detail || "Could not send invitation");
    }
    setSubmitting(false);
  }

  async function handleRevoke(id) {
    const result = await revokeTeamMember(id);
    if (result?.team_member_id) {
      setMembers((prev) => prev.map((m) => (m.team_member_id === id ? result : m)));
      onToast?.("Access revoked", "success");
    }
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h3 style={{ fontSize: 18 }}>Audit Team Management</h3>
      </div>
      <p style={{ color: "var(--text-gray)", marginBottom: 24, fontSize: 13 }}>
        Invite team members to your workspace. They'll receive an email with an invite link.
      </p>

      <form onSubmit={handleInvite} style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        <input
          type="email"
          className="form-control"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="colleague@example.com"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          maxLength={255}
          required
        />
        <select
          className="form-control"
          style={{ width: 160 }}
          value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
        >
          {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Sending…" : "+ Invite Team Member"}
        </button>
      </form>
      {error && <div className="inline-error" style={{ marginBottom: 16 }}>{error}</div>}

      {members.length === 0 && (
        <p style={{ color: "var(--text-gray)", fontSize: 13 }}>No team members invited yet.</p>
      )}
      {members.map((m) => (
        <div className="list-row" key={m.team_member_id}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{m.invited_email}</span>
              {statusBadge(m.status)}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-gray)" }}>
              {m.role} · invited {new Date(m.invited_at).toLocaleDateString()}
            </div>
          </div>
          {m.status !== "REVOKED" && (
            <button
              style={{ padding: "6px 12px", fontSize: 12, borderRadius: 8, background: "rgba(255,91,91,0.1)", color: "var(--danger-color)", border: "none", cursor: "pointer", fontWeight: 600 }}
              onClick={() => handleRevoke(m.team_member_id)}
            >
              Revoke
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
