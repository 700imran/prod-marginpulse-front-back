/**
 * App.jsx — Main application shell. Neomorphism theme (matching the
 * user-provided mockup), with every nav item wired to real data and a
 * working Profile dropdown (load/edit/save, change password, logout).
 */
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import LoginPage from "./LoginPage";
import { isLoggedIn, logout, getProfile } from "./api";
import { GLOBAL_CSS, Icons, NAV_SECTIONS, Toast } from "./theme";

// Every screen is its own chunk, loaded only when navigated to — keeps
// the initial bundle to just the app shell + whichever screen loads
// first, instead of shipping all 14 screens' code up front.
const DashboardView = lazy(() => import("./components/DashboardView"));
const DocumentsView = lazy(() => import("./components/DocumentsView"));
const GSTSyncView = lazy(() => import("./components/GSTSyncView"));
const ProfileView = lazy(() => import("./components/ProfileView"));
const TaxBankView = lazy(() => import("./components/TaxBankView"));
const ReconciliationRulesView = lazy(() => import("./components/ReconciliationRulesView"));
const IntegrationsView = lazy(() => import("./components/IntegrationsView"));
const NotificationsView = lazy(() => import("./components/NotificationsView"));
const SecurityView = lazy(() => import("./components/SecurityView"));
const BillingView = lazy(() => import("./components/BillingView"));
const TeamView = lazy(() => import("./components/TeamView"));
const AdminPanelView = lazy(() => import("./components/AdminPanelView"));
const ROICalculatorView = lazy(() => import("./components/ROICalculatorView"));
const AuditLogView = lazy(() => import("./components/AuditLogView"));

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
            <button
              type="button"
              className="logo-toggle-btn"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <svg className="logo-mark" viewBox="0 0 100 100" aria-hidden="true">
                <defs>
                  <linearGradient id="mpBrandGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#aee9da" />
                    <stop offset="100%" stopColor="#0f6e56" />
                  </linearGradient>
                </defs>
                <rect x="8" y="56" width="17" height="30" rx="3" fill="url(#mpBrandGrad)" />
                <rect x="32" y="40" width="17" height="46" rx="3" fill="url(#mpBrandGrad)" />
                <rect x="56" y="24" width="17" height="62" rx="3" fill="url(#mpBrandGrad)" />
                <path d="M5 64 L27 36 L42 52 L66 14" fill="none" stroke="url(#mpBrandGrad)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M66 14 L86 6 L79 26" fill="none" stroke="url(#mpBrandGrad)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <svg className="logo-hover-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
            <span className="logo-text">
              <span className="logo-text-dark">Margin</span><span className="logo-text-accent">Pulse</span>
            </span>
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
            <Suspense fallback={<div className="view-loading">Loading…</div>}>
              {renderContent()}
            </Suspense>
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
