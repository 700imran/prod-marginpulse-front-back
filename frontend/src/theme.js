/**
 * theme.js — Shared CSS (neomorphism theme) and icon set used across the
 * whole app. Pulled out of App.jsx so the large CSS-in-JS string and icon
 * definitions don't make every component file harder to scan.
 */
import React from "react";

export const GLOBAL_CSS = `
:root {
    --primary-color: #00c07f;
    --primary-light: #e6f8f1;
    --bg-color: #e9ecef;
    --card-bg: #ffffff;
    --text-dark: #1a1a1a;
    --text-gray: #717d8a;
    --border-color: #dfe4e8;
    --danger-color: #ff5b5b;
    --warning-color: #f5a623;
    --border-radius: 16px;
    --pro-color: #8b5cf6;
}

* { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }

body { background-color: #d8dee3; color: var(--text-dark); }

.dashboard-container {
    width: 100%; max-width: 1500px; height: 96vh; margin: 2vh auto;
    background-color: var(--bg-color); border-radius: 24px; display: flex;
    overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.08);
}

/* --- Sidebar --- */
.sidebar {
    width: 260px; background-color: var(--card-bg); padding: 30px 20px;
    display: flex; flex-direction: column; border-right: 1px solid var(--border-color);
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; flex-shrink: 0; position: relative;
}
.sidebar.collapsed { width: 80px; }
.logo { font-size: 20px; font-weight: bold; display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px; color: var(--text-dark); white-space: nowrap; }
.logo-inner { display: flex; align-items: center; gap: 10px; }
.sidebar.collapsed .logo-text { opacity: 0; width: 0; overflow: hidden; }
.logo-icon { width: 26px; height: 26px; background: var(--primary-color); border-radius: 6px; transform: skewX(-10deg); flex-shrink: 0; box-shadow: 0 4px 10px rgba(0, 192, 127, 0.3); }
.sidebar-toggle { background: none; border: none; cursor: pointer; color: var(--text-gray); font-size: 18px; transition: transform 0.2s; }
.sidebar-toggle:hover { color: var(--primary-color); }
.nav-section { margin-bottom: 25px; }
.nav-section p { font-size: 11px; font-weight: 700; color: var(--text-gray); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; transition: opacity 0.2s; }
.sidebar.collapsed .nav-section p { opacity: 0; height: 0; margin: 0; }
.nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; color: var(--text-gray); text-decoration: none; border-radius: 10px; margin-bottom: 4px; font-weight: 600; font-size: 14px; transition: all 0.2s ease; white-space: nowrap; cursor: pointer; border: none; background: transparent; width: 100%; text-align: left; }
.nav-item:hover { background-color: rgba(0, 192, 127, 0.05); color: var(--text-dark); }
.nav-item.active { background-color: var(--primary-light); color: var(--primary-color); }
.sidebar.collapsed .nav-label, .sidebar.collapsed .nav-badge { display: none; }
.sidebar.collapsed .nav-item { justify-content: center; padding: 14px 0; }
.nav-badge { margin-left: auto; font-size: 10px; padding: 3px 8px; border-radius: 12px; font-weight: 800; }
.badge-pro { background: rgba(139, 92, 246, 0.1); color: var(--pro-color); }
.badge-alert { background: rgba(245, 166, 35, 0.1); color: var(--warning-color); }
.badge-ok { background: rgba(0, 192, 127, 0.1); color: var(--primary-color); }
.logout { margin-top: auto; color: var(--danger-color); }
.logout:hover { background: rgba(255, 91, 91, 0.05); }

/* --- Main Content --- */
.main-content { flex: 1; padding: 40px; display: flex; flex-direction: column; overflow-y: auto; position: relative; }
.main-content::-webkit-scrollbar { width: 8px; }
.main-content::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }

.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.header h2 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }

.user-profile { display: flex; align-items: center; gap: 15px; background: var(--card-bg); padding: 6px 16px 6px 6px; border-radius: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.02); cursor: pointer; transition: box-shadow 0.2s; position: relative; }
.user-profile:hover { box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
.avatar { width: 36px; height: 36px; background: linear-gradient(135deg, var(--primary-color), #009965); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 14px; flex-shrink: 0; }

.profile-dropdown {
    position: absolute; top: calc(100% + 10px); right: 0; width: 280px;
    background: var(--card-bg); border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.12);
    padding: 8px; z-index: 100; border: 1px solid var(--border-color);
}
.profile-dropdown-header { padding: 14px 14px 12px; border-bottom: 1px solid var(--border-color); margin-bottom: 6px; }
.profile-dropdown-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 10px 14px; border-radius: 10px; border: none; background: transparent; font-size: 13px; font-weight: 600; color: var(--text-dark); cursor: pointer; transition: background 0.15s; }
.profile-dropdown-item:hover { background: var(--bg-color); }
.profile-dropdown-item.danger { color: var(--danger-color); }
.profile-dropdown-item.danger:hover { background: rgba(255,91,91,0.08); }

/* Cards */
.card { background: var(--card-bg); border-radius: var(--border-radius); padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.03); margin-bottom: 24px; transition: transform 0.2s, box-shadow 0.2s; }
.card:hover { box-shadow: 0 6px 24px rgba(0,0,0,0.05); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }

/* Forms & Inputs */
.form-group { margin-bottom: 24px; }
.form-label { display: block; font-size: 13px; color: var(--text-gray); margin-bottom: 8px; font-weight: 600; }
.form-control { width: 100%; padding: 14px 16px; border: 1px solid var(--border-color); border-radius: 12px; font-size: 15px; color: var(--text-dark); background: var(--bg-color); transition: all 0.2s; outline: none; box-sizing: border-box; }
.form-control:focus { border-color: var(--primary-color); background: var(--card-bg); box-shadow: 0 0 0 3px var(--primary-light); }
.form-control:disabled { opacity: 0.6; cursor: not-allowed; }

/* Toggles */
.toggle-container { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--border-color); }
.toggle-container:last-child { border-bottom: none; }
.toggle-info h4 { font-size: 16px; margin-bottom: 6px; color: var(--text-dark); }
.toggle-info p { font-size: 13px; color: var(--text-gray); line-height: 1.5; }
.switch { position: relative; display: inline-block; width: 48px; height: 26px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #cbd5e1; transition: .3s cubic-bezier(0.4, 0, 0.2, 1); border-radius: 34px; }
.slider:before { position: absolute; content: ""; height: 20px; width: 20px; left: 3px; bottom: 3px; background-color: white; transition: .3s cubic-bezier(0.4, 0, 0.2, 1); border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
input:checked + .slider { background-color: var(--primary-color); }
input:checked + .slider:before { transform: translateX(22px); }
.switch.disabled .slider { opacity: 0.5; cursor: not-allowed; }

/* Buttons */
.btn { padding: 12px 24px; border-radius: 12px; font-weight: 600; font-size: 14px; cursor: pointer; border: none; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none !important; }
.btn-primary { background: var(--primary-color); color: white; box-shadow: 0 4px 12px rgba(0, 192, 127, 0.2); }
.btn-primary:hover:not(:disabled) { background: #00a86f; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0, 192, 127, 0.3); }
.btn-ghost { background: var(--bg-color); color: var(--text-gray); }
.btn-ghost:hover:not(:disabled) { background: var(--border-color); }
.btn-danger-ghost { background: rgba(255,91,91,0.1); color: var(--danger-color); }
.btn-danger-ghost:hover:not(:disabled) { background: rgba(255,91,91,0.18); }

.pro-block { opacity: 0.6; pointer-events: none; background: #f8fafc; }

.badge-pill { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-verified { background: rgba(0,192,127,0.12); color: #00875a; }
.badge-pending { background: rgba(245,166,35,0.12); color: #b07300; }
.badge-failed { background: rgba(255,91,91,0.12); color: #c93a3a; }
.badge-unverified { background: #eef1f3; color: var(--text-gray); }

.list-row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border-color); gap: 16px; }
.list-row:last-child { border-bottom: none; }

.fade-in { animation: fadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.icon-wrapper { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; }

.inline-error { color: var(--danger-color); font-size: 12px; margin-top: 6px; }
.inline-success { color: var(--primary-color); font-size: 12px; margin-top: 6px; }
.toast {
  position: fixed; bottom: 24px; right: 24px; background: var(--text-dark); color: #fff;
  padding: 14px 20px; border-radius: 12px; font-size: 13px; font-weight: 600;
  box-shadow: 0 8px 24px rgba(0,0,0,0.2); z-index: 999; max-width: 360px;
}
.toast.error { background: var(--danger-color); }
.toast.success { background: var(--primary-color); }
`;

// ─── CUSTOM SVG ICONS ──────────────────────────────────────────────────────
export const Icons = {
  Dashboard: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"></rect>
      <rect x="14" y="3" width="7" height="7" rx="1"></rect>
      <rect x="14" y="14" width="7" height="7" rx="1"></rect>
      <rect x="3" y="14" width="7" height="7" rx="1"></rect>
    </svg>
  ),
  Documents: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="9" y1="15" x2="15" y2="15"></line>
    </svg>
  ),
  Sync: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6"></path>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
      <path d="M3 22v-6h6"></path>
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
    </svg>
  ),
  Profile: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
      <circle cx="12" cy="7" r="4"></circle>
    </svg>
  ),
  Rules: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"></polyline>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
      <polyline points="7 23 3 19 7 15"></polyline>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
    </svg>
  ),
  Lightning: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>
  ),
  Bell: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
    </svg>
  ),
  Lock: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  ),
  CreditCard: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect>
      <line x1="1" y1="10" x2="23" y2="10"></line>
    </svg>
  ),
  Users: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  ),
  Logout: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
      <polyline points="16 17 21 12 16 7"></polyline>
      <line x1="21" y1="12" x2="9" y2="12"></line>
    </svg>
  ),
  Bank: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="21" x2="21" y2="21"></line>
      <line x1="3" y1="10" x2="21" y2="10"></line>
      <polyline points="5 6 12 3 19 6"></polyline>
      <line x1="4" y1="10" x2="4" y2="21"></line>
      <line x1="20" y1="10" x2="20" y2="21"></line>
      <line x1="8" y1="14" x2="8" y2="17"></line>
      <line x1="12" y1="14" x2="12" y2="17"></line>
      <line x1="16" y1="14" x2="16" y2="17"></line>
    </svg>
  ),
  Key: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
    </svg>
  ),
  Plus: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  ),
  Trash: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    </svg>
  ),
};

// ─── NAV STRUCTURE ────────────────────────────────────────────────────────
export const NAV_SECTIONS = [
  {
    title: "Main Menu",
    items: [
      { id: "dashboard", label: "Dashboard", icon: <Icons.Dashboard /> },
      { id: "documents", label: "Documents Matrix", icon: <Icons.Documents /> },
      { id: "gst", label: "Tax Portal Sync", icon: <Icons.Sync /> },
      { id: "roi", label: "ROI Calculator", icon: <Icons.Lightning /> },
    ],
  },
  {
    title: "Settings & Config",
    items: [
      { id: "profile", label: "Profile Configurations", icon: <Icons.Profile /> },
      { id: "taxbank", label: "Tax IDs & Bank Accounts", icon: <Icons.Bank /> },
      { id: "recon", label: "Reconciliation Rules", icon: <Icons.Rules /> },
      { id: "api", label: "API & Integrations", icon: <Icons.Lightning /> },
      { id: "notify", label: "Notifications", icon: <Icons.Bell /> },
      { id: "security", label: "Security & Sessions", icon: <Icons.Lock /> },
      { id: "auditlog", label: "Audit Trail", icon: <Icons.Key /> },
    ],
  },
  {
    title: "Premium",
    items: [
      { id: "billing", label: "Billing & Plans", icon: <Icons.CreditCard />, badge: "Pro", badgeClass: "badge-pro" },
      { id: "team", label: "Audit Team", icon: <Icons.Users /> },
    ],
  },
];

// ─── SHARED SMALL COMPONENTS ──────────────────────────────────────────────
export const Toggle = ({ title, desc, checked, onChange, disabled }) => (
  <div className="toggle-container">
    <div className="toggle-info">
      <h4>{title}</h4>
      <p>{desc}</p>
    </div>
    <label className={`switch ${disabled ? "disabled" : ""}`}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange && onChange(e.target.checked)} disabled={disabled} />
      <span className="slider"></span>
    </label>
  </div>
);

export const VerificationBadge = ({ status }) => {
  const map = {
    VERIFIED: { cls: "badge-verified", label: "Verified" },
    PENDING: { cls: "badge-pending", label: "Pending" },
    FAILED: { cls: "badge-failed", label: "Failed" },
    UNVERIFIED: { cls: "badge-unverified", label: "Unverified" },
  };
  const s = map[status] || map.UNVERIFIED;
  return <span className={`badge-pill ${s.cls}`}>{s.label}</span>;
};

export function Toast({ message, type, onClose }) {
  if (!message) return null;
  return (
    <div className={`toast ${type || ""}`} onClick={onClose}>
      {message}
    </div>
  );
}
