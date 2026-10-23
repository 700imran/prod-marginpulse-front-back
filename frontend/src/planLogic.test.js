import { isFeatureLocked, lockInfo, navBadge, NAV_FEATURE, formatExpiry } from "./planLogic";

const catalogue = (currentPlan, over = {}) => ({
  currentPlan, currentPlanLabel: { FREE: "Free", STARTER: "Starter", GROWTH: "Pro", ENTERPRISE: "Enterprise" }[currentPlan],
  gatingEnforced: true,
  plans: [{ id: "FREE" }, { id: "STARTER" }, { id: "GROWTH" }, { id: "ENTERPRISE" }],
  features: {
    gst_sync: { label: "Tax Portal Sync", minPlan: "STARTER", minPlanLabel: "Starter" },
    team: { label: "Audit Team", minPlan: "GROWTH", minPlanLabel: "Pro" },
  },
  ...over,
});

describe("isFeatureLocked", () => {
  test.each([
    ["FREE", "gst_sync", true], ["STARTER", "gst_sync", false], ["GROWTH", "gst_sync", false],
    ["FREE", "team", true], ["STARTER", "team", true], ["GROWTH", "team", false], ["ENTERPRISE", "team", false],
  ])("%s on %s → locked=%s", (plan, feature, locked) => expect(isFeatureLocked(catalogue(plan), feature)).toBe(locked));

  test("fails OPEN: no data, not enforcing, unknown or missing feature → never locked", () => {
    expect(isFeatureLocked(null, "gst_sync")).toBe(false);
    expect(isFeatureLocked(undefined, "gst_sync")).toBe(false);
    expect(isFeatureLocked(catalogue("FREE", { gatingEnforced: false }), "gst_sync")).toBe(false);
    expect(isFeatureLocked(catalogue("FREE"), "does_not_exist")).toBe(false);
    expect(isFeatureLocked(catalogue("FREE"), undefined)).toBe(false);
  });
});

test("lockInfo describes what to upgrade to", () => {
  expect(lockInfo(catalogue("FREE"), "team")).toMatchObject({ label: "Audit Team", requiredPlanLabel: "Pro", currentPlanLabel: "Free" });
  expect(lockInfo(catalogue("FREE"), "nope")).toBeNull();
});

describe("navBadge", () => {
  test("is derived from the plans table, so sidebar and pricing page can't disagree", () => {
    expect(navBadge({ id: "gst", badge: "Pro", badgeClass: "badge-pro" }, catalogue("FREE"))).toEqual({ text: "Starter", className: "badge-pro" });
    expect(navBadge({ id: "team", badge: "Growth", badgeClass: "badge-growth" }, catalogue("FREE"))).toEqual({ text: "Pro", className: "badge-growth" });
  });
  test("falls back to the static badge before plans load, and to nothing for ungated items", () => {
    expect(navBadge({ id: "gst", badge: "Pro", badgeClass: "badge-pro" }, null)).toEqual({ text: "Pro", className: "badge-pro" });
    expect(navBadge({ id: "dashboard" }, catalogue("FREE"))).toBeNull();
    expect(navBadge({ id: "assistant", badge: "Beta", badgeClass: "badge-growth" }, catalogue("FREE"))).toEqual({ text: "Beta", className: "badge-growth" });
  });
});

test("every gated nav item maps to a feature key", () => {
  expect(Object.keys(NAV_FEATURE).sort()).toEqual(["api", "auditlog", "gst", "notify", "recon", "team"]);
});

test("formatExpiry", () => {
  expect(formatExpiry(null)).toBeNull();
  expect(formatExpiry("garbage")).toBeNull();
  expect(formatExpiry("2026-11-21T00:00:00Z")).toMatch(/2026/);
});
