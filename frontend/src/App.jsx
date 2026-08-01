/**
 * App.jsx — Main application shell. Neomorphism theme (matching the
 * user-provided mockup), with every nav item wired to real data and a
 * working Profile dropdown (load/edit/save, change password, logout).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import LoginPage from "./LoginPage";
import { isLoggedIn, logout, getProfile } from "./api";
import { GLOBAL_CSS, Icons, NAV_SECTIONS, Toast } from "./theme";

import DashboardView from "./components/DashboardView";
import DocumentsView from "./components/DocumentsView";
import GSTSyncView from "./components/GSTSyncView";
import ProfileView from "./components/ProfileView";
import TaxBankView from "./components/TaxBankView";
import ReconciliationRulesView from "./components/ReconciliationRulesView";
import IntegrationsView from "./components/IntegrationsView";
import NotificationsView from "./components/NotificationsView";
import SecurityView from "./components/SecurityView";
import BillingView from "./components/BillingView";
import TeamView from "./components/TeamView";
import AdminPanelView from "./components/AdminPanelView";
import ROICalculatorView from "./components/ROICalculatorView";
import AuditLogView from "./components/AuditLogView";

function initials(name) {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AppShell() {
  const [activeNav, setActiveNav] = useState("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tenant, setTenant] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [toast, setToast] = useState({ message: "", type: "" });
  const dropdownRef = useRef(null);

  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast({ message: "", type: "" }), 3500);
  }, []);

  useEffect(() => {
    getProfile().then((data) => { if (data?.tenant_id) setTenant(data); });
  }, []);

  // Close the profile dropdown on outside click.
  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const navSections = tenant?.is_platform_admin
    ? [...NAV_SECTIONS, { title: "Platform Admin", items: [{ id: "admin", label: "Admin Panel", icon: <Icons.Key /> }] }]
    : NAV_SECTIONS;

  const activeTitle = navSections.flatMap((s) => s.items).find((i) => i.id === activeNav)?.label || "Dashboard";
  const displayName = tenant?.display_name || tenant?.business_name || "Loading…";

  function renderContent() {
    switch (activeNav) {
      case "dashboard": return <DashboardView onToast={showToast} tenant={tenant} onNavigate={setActiveNav} />;
      case "documents": return <DocumentsView onToast={showToast} />;
      case "gst": return <GSTSyncView onToast={showToast} />;
      case "profile": return <ProfileView onToast={showToast} onProfileUpdated={setTenant} />;
      case "taxbank": return <TaxBankView onToast={showToast} />;
      case "recon": return <ReconciliationRulesView onToast={showToast} />;
      case "api": return <IntegrationsView onToast={showToast} />;
      case "notify": return <NotificationsView onToast={showToast} />;
      case "security": return <SecurityView onToast={showToast} />;
      case "roi": return <ROICalculatorView />;
      case "auditlog": return <AuditLogView />;
      case "billing": return <BillingView tenant={tenant} />;
      case "team": return <TeamView onToast={showToast} />;
      case "admin": return <AdminPanelView onToast={showToast} />;
      default: return null;
    }
  }

  return (
    <>
      <style>{GLOBAL_CSS}</style>

      <div className="dashboard-container">
        {/* SIDEBAR */}
        <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="logo">
            <div className="logo-inner">
              <div className="logo-icon"></div>
              <span className="logo-text">MarginPulse</span>
            </div>
            <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
              ☰
            </button>
          </div>

          {navSections.map((section, idx) => (
            <div className="nav-section" key={idx}>
              <p>{section.title}</p>
              {section.items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${activeNav === item.id ? "active" : ""}`}
                  onClick={() => setActiveNav(item.id)}
                >
                  <span className="icon-wrapper">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                  {item.badge && <span className={`nav-badge ${item.badgeClass}`}>{item.badge}</span>}
                </button>
              ))}
            </div>
          ))}

          <button className="nav-item logout" style={{ marginTop: "auto" }} onClick={() => logout()}>
            <span className="icon-wrapper"><Icons.Logout /></span>
            <span className="nav-label">Log Out</span>
          </button>
        </aside>

        {/* MAIN CONTENT */}
        <main className="main-content">
          <div className="header">
            <h2>{activeTitle}</h2>
            <div className="user-profile" ref={dropdownRef} onClick={() => setDropdownOpen((o) => !o)}>
              <div className="avatar">{initials(displayName)}</div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{displayName}</span>

              {dropdownOpen && (
                <div className="profile-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="profile-dropdown-header">
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{displayName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-gray)" }}>{tenant?.owner_email}</div>
                  </div>
                  <button className="profile-dropdown-item" onClick={() => { setActiveNav("profile"); setDropdownOpen(false); }}>
                    <span className="icon-wrapper"><Icons.Profile /></span> Edit Profile
                  </button>
                  <button className="profile-dropdown-item" onClick={() => { setActiveNav("taxbank"); setDropdownOpen(false); }}>
                    <span className="icon-wrapper"><Icons.Bank /></span> Tax IDs & Bank Accounts
                  </button>
                  <button className="profile-dropdown-item" onClick={() => { setActiveNav("security"); setDropdownOpen(false); }}>
                    <span className="icon-wrapper"><Icons.Lock /></span> Security & Password
                  </button>
                  <button className="profile-dropdown-item danger" onClick={() => logout()}>
                    <span className="icon-wrapper"><Icons.Logout /></span> Log Out
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="fade-in" key={activeNav}>
            {renderContent()}
          </div>
        </main>
      </div>

      <Toast message={toast.message} type={toast.type} onClose={() => setToast({ message: "", type: "" })} />
    </>
  );
}

/**
 * Handles the redirect back from the backend after a successful
 * Google/Apple OAuth login (see internal/httpapi/oauth_handlers.go's
 * oauthSuccessRedirect — tokens ride in the URL FRAGMENT, not the query
 * string, so they're never sent to any server or logged by a CDN/proxy
 * along the way). Runs synchronously before the first render decides
 * whether to show LoginPage or the authenticated app, so a successful
 * OAuth login lands the user straight in the dashboard rather than
 * bouncing through the login screen once more.
 */
function consumeOAuthCallbackIfPresent() {
  if (!window.location.hash.startsWith("#/oauth-callback")) return;
  const query = window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(query);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  const tenantId = params.get("tenant_id");
  if (accessToken && refreshToken) {
    localStorage.setItem("mp_access_token", accessToken);
    localStorage.setItem("mp_refresh_token", refreshToken);
    if (tenantId) localStorage.setItem("mp_tenant_id", tenantId);
  }
  // Strip the tokens out of the visible URL immediately — leaving them
  // in window.location would keep them in browser history.
  window.history.replaceState(null, "", window.location.pathname);
}

export default function App() {
  consumeOAuthCallbackIfPresent();
  const [authed, setAuthed] = useState(isLoggedIn());
  if (!authed) return <LoginPage onSuccess={() => setAuthed(true)} />;
  return <AppShell />;
}
