/**
 * App.jsx — Main application shell. Neomorphism theme (matching the
 * user-provided mockup), with every nav item wired to real data and a
 * working Profile dropdown (load/edit/save, change password, logout).
 */
import { useState, useEffect, useRef, useCallback, useTransition, lazy, Suspense } from "react";
import LoginPage from "./LoginPage";
import { isLoggedIn, logout, getProfile, prefetchAppData } from "./api";
import { tokenManager } from "./security/tokenManager";
import { GLOBAL_CSS, Icons, NAV_SECTIONS, Toast } from "./theme";

// Every screen is its own chunk, loaded only when navigated to — keeps
// the initial bundle to just the app shell + whichever screen loads
// first, instead of shipping all 14 screens' code up front.
const loaders = {
  dashboard: () => import("./components/DashboardView"),
  documents: () => import("./components/DocumentsView"),
  gst: () => import("./components/GSTSyncView"),
  profile: () => import("./components/ProfileView"),
  taxbank: () => import("./components/TaxBankView"),
  recon: () => import("./components/ReconciliationRulesView"),
  api: () => import("./components/IntegrationsView"),
  notify: () => import("./components/NotificationsView"),
  security: () => import("./components/SecurityView"),
  billing: () => import("./components/BillingView"),
  team: () => import("./components/TeamView"),
  admin: () => import("./components/AdminPanelView"),
  roi: () => import("./components/ROICalculatorView"),
  auditlog: () => import("./components/AuditLogView"),
};
const DashboardView = lazy(loaders.dashboard);
const DocumentsView = lazy(loaders.documents);
const GSTSyncView = lazy(loaders.gst);
const ProfileView = lazy(loaders.profile);
const TaxBankView = lazy(loaders.taxbank);
const ReconciliationRulesView = lazy(loaders.recon);
const IntegrationsView = lazy(loaders.api);
const NotificationsView = lazy(loaders.notify);
const SecurityView = lazy(loaders.security);
const BillingView = lazy(loaders.billing);
const TeamView = lazy(loaders.team);
const AdminPanelView = lazy(loaders.admin);
const ROICalculatorView = lazy(loaders.roi);
const AuditLogView = lazy(loaders.auditlog);

// Minimal identity (name / org / plan) kept across tabs and refreshes so the
// header never has to say "Loading…". Only used when it belongs to the signed-in user.
function readIdentityHint() {
  try {
    const h = JSON.parse(localStorage.getItem("mp_identity") || "null");
    return h && h.tenantId && h.tenantId === tokenManager.getTenantId() ? h : null;
  } catch { return null; }
}
function saveIdentityHint(p) {
  try {
    localStorage.setItem("mp_identity", JSON.stringify({
      tenantId: p.tenantId, displayName: p.displayName ?? null, businessName: p.businessName ?? null,
      ownerEmail: p.ownerEmail ?? null, planTier: p.planTier ?? null, isPlatformAdmin: !!p.isPlatformAdmin,
    }));
  } catch { /* storage unavailable */ }
}

function initials(name) {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AppShell() {
  const [activeNav, setActiveNav] = useState("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [, startTransition] = useTransition();
  const [viewKey, setViewKey] = useState(0);
  // Paint instantly from what we already know (full profile for this tab, else the
  // small identity hint) and refresh in the background — no spinner on refresh.
  const [cachedProfile] = useState(() => {
    try {
      const full = JSON.parse(sessionStorage.getItem("mp_profile") || "null");
      if (full?.tenantId && full.tenantId === tokenManager.getTenantId()) return full;
    } catch { /* ignore */ }
    return readIdentityHint();
  });
  const [tenant, setTenant] = useState(cachedProfile);
  const [profile, setProfile] = useState(cachedProfile);
  const [profileLoading, setProfileLoading] = useState(!cachedProfile);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [toast, setToast] = useState({ message: "", type: "" });
  const dropdownRef = useRef(null);

  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast({ message: "", type: "" }), 3500);
  }, []);

  useEffect(() => {
    let active = true;
    getProfile()
      .then((data) => {
        if (!active) return;
        // Ignore error payloads ({error: ...}) — keep whatever we already have.
        if (data?.tenantId) {
          setProfile(data);
          setTenant(data);
          try { sessionStorage.setItem("mp_profile", JSON.stringify(data)); } catch { /* storage unavailable */ }
          saveIdentityHint(data);
        }
        setProfileLoading(false);
      })
      .catch(() => {
        if (active) setProfileLoading(false);
      });

    // After the first paint: pull every screen's code and data into cache in the
    // background, so clicking any feature (Pro / Growth / unlabelled) is instant.
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 150));
    const handle = idle(() => {
      Object.values(loaders).forEach((load) => load().catch(() => {}));
      prefetchAppData();
    });

    // Background refresh found newer data → re-read the open screen (from cache, instant),
    // unless the user is typing, so we never wipe a form they're filling in.
    let timer;
    const onUpdated = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
        setViewKey((k) => k + 1);
      }, 150);
    };
    window.addEventListener("mp:data-updated", onUpdated);

    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("mp:data-updated", onUpdated);
      if (window.cancelIdleCallback && typeof handle === "number") window.cancelIdleCallback(handle);
    };
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

  const navSections = tenant?.isPlatformAdmin
    ? [...NAV_SECTIONS, { title: "Platform Admin", items: [{ id: "admin", label: "Admin Panel", icon: <Icons.Key /> }] }]
    : NAV_SECTIONS;

  const activeTitle = navSections.flatMap((s) => s.items).find((i) => i.id === activeNav)?.label || "Dashboard";
  // Name → organisation → what the sign-in session already knows. Never "Loading…".
  const displayName = tenant?.displayName || tenant?.businessName || tokenManager.getUserLabel() || "My workspace";
  const orgName = tenant?.businessName && tenant.businessName !== displayName ? tenant.businessName : "";
  const navigate = (id) => startTransition(() => setActiveNav(id)); // keep the current screen visible until the next is ready

  function renderContent() {
    switch (activeNav) {
      case "dashboard": return <DashboardView onToast={showToast} tenant={tenant} onNavigate={navigate} />;
      case "documents": return <DocumentsView onToast={showToast} />;
      case "gst": return <GSTSyncView onToast={showToast} />;
      case "profile":
        return (
          <ProfileView
            profile={profile}
            profileLoading={profileLoading}
            onToast={showToast}
            onProfileUpdated={(updated) => {
              setProfile(updated ?? profile);
              setTenant(updated ?? tenant);
              if (updated?.tenantId) { saveIdentityHint(updated); try { sessionStorage.setItem("mp_profile", JSON.stringify(updated)); } catch { /* ignore */ } }
            }}
          />
        );
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
                  onClick={() => navigate(item.id)}
                  onMouseEnter={() => loaders[item.id]?.().catch(() => {})}
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
                    {orgName && <div style={{ fontSize: 12, fontWeight: 600 }}>{orgName}</div>}
                    <div style={{ fontSize: 12, color: "var(--text-gray)" }}>{tenant?.ownerEmail || tokenManager.getUserLabel()}</div>
                  </div>
                  <button className="profile-dropdown-item" onClick={() => { navigate("profile"); setDropdownOpen(false); }}>
                    <span className="icon-wrapper"><Icons.Profile /></span> Edit Profile
                  </button>
                  <button className="profile-dropdown-item" onClick={() => { navigate("taxbank"); setDropdownOpen(false); }}>
                    <span className="icon-wrapper"><Icons.Bank /></span> Tax IDs & Bank Accounts
                  </button>
                  <button className="profile-dropdown-item" onClick={() => { navigate("security"); setDropdownOpen(false); }}>
                    <span className="icon-wrapper"><Icons.Lock /></span> Security & Password
                  </button>
                  <button className="profile-dropdown-item danger" onClick={() => logout()}>
                    <span className="icon-wrapper"><Icons.Logout /></span> Log Out
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="fade-in">
            <Suspense fallback={<div className="view-skeleton" aria-busy="true"><div className="skeleton sk-title" /><div className="skeleton sk-row" /><div className="skeleton sk-row" /><div className="skeleton sk-row short" /></div>}>
              <div key={viewKey}>{renderContent()}</div>
            </Suspense>
          </div>
        </main>
      </div>

      <Toast message={toast.message} type={toast.type} onClose={() => setToast({ message: "", type: "" })} />
    </>
  );
}


export default function App() {
  const [authed, setAuthed] = useState(isLoggedIn());
  if (!authed) return <LoginPage onSuccess={() => setAuthed(true)} />;
  return <AppShell />;
}
