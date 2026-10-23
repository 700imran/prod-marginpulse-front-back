// Pure helpers for plan-based locking. Everything keys off the response of
// GET /api/v1/billing/plans (see backend billing/plans.ts), so the frontend never
// carries its own copy of "which plan unlocks what".
//
// Fail-open on purpose: if the plans data hasn't loaded (or the call failed) nothing
// is shown as locked. The backend is what actually enforces; the UI only explains.

export const NAV_FEATURE = {
  gst: "gst_sync", recon: "recon_rules", auditlog: "audit_log",
  api: "integrations", notify: "notifications", team: "team",
};

// Short plain-language blurbs for the locked screen. Keep these factual — they
// describe what the screen does, not marketing claims.
export const FEATURE_BLURBS = {
  gst_sync: "Pull GSTR-2B data from the GST portal and match it against your invoices, so you can see which vendors haven't filed and how much input tax credit is at risk.",
  recon_rules: "Tune how invoices and bank entries are matched to each other, and how duplicates and mismatches are flagged.",
  audit_log: "See a history of the changes made to your documents and settings.",
  integrations: "Connect your other tools so data flows into MarginPulse automatically.",
  notifications: "Choose which alerts you receive, and where they are sent.",
  team: "Invite team members to your account and manage who has been invited.",
};

const rankOf = (plans, id) => Math.max(0, (plans?.plans || []).findIndex((p) => p.id === id));

/** Is this feature locked for the current tenant? Unknown / not enforcing → false. */
export function isFeatureLocked(plans, feature) {
  if (!plans || !plans.gatingEnforced || !feature) return false;
  const f = plans.features?.[feature];
  if (!f) return false;
  return rankOf(plans, plans.currentPlan) < rankOf(plans, f.minPlan);
}

export function lockInfo(plans, feature) {
  const f = plans?.features?.[feature];
  if (!f) return null;
  return {
    feature, label: f.label, requiredPlan: f.minPlan, requiredPlanLabel: f.minPlanLabel,
    currentPlan: plans.currentPlan, currentPlanLabel: plans.currentPlanLabel,
  };
}

const BADGE_CLASS = { STARTER: "badge-pro", GROWTH: "badge-growth", ENTERPRISE: "badge-scale" };

/** The sidebar badge for a nav item: derived from the plans table when available, else the static one. */
export function navBadge(item, plans) {
  const feature = NAV_FEATURE[item.id];
  const f = feature && plans?.features?.[feature];
  if (f) return { text: f.minPlanLabel, className: BADGE_CLASS[f.minPlan] || "badge-growth" };
  return item.badge ? { text: item.badge, className: item.badgeClass } : null;
}

export function formatExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
