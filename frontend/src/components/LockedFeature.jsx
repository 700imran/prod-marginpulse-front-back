/**
 * LockedFeature — what a plan-gated screen shows when the current plan doesn't
 * include it. The feature stays visible in the sidebar; opening it explains what
 * it is and sends the user to the pricing page, instead of a blank or broken screen.
 * Nothing here calls the feature's API (it would only answer 402).
 */
import { Icons } from "../theme";
import { FEATURE_BLURBS, lockInfo } from "../planLogic";

export default function LockedFeature({ plans, feature, onUpgrade }) {
  const info = lockInfo(plans, feature);
  if (!info) return null;
  return (
    <div className="card" role="region" aria-label={`${info.label} requires the ${info.requiredPlanLabel} plan`}>
      <div className="notice-bar" role="status" style={{ marginBottom: 20 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 16, height: 16, display: "inline-flex" }}><Icons.Lock /></span>
          <span><strong>{info.label}</strong> is part of the <strong>{info.requiredPlanLabel}</strong> plan. You're on <strong>{info.currentPlanLabel}</strong>.</span>
        </span>
        <button className="btn btn-primary" onClick={onUpgrade}>See plans &amp; upgrade</button>
      </div>
      <h3 style={{ fontSize: 18, marginBottom: 8 }}>{info.label}</h3>
      <p style={{ color: "var(--text-gray)", fontSize: 14, lineHeight: 1.6, maxWidth: 640 }}>{FEATURE_BLURBS[feature] || ""}</p>
    </div>
  );
}
