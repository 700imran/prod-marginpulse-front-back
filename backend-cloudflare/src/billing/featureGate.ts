// Route guard: "this endpoint belongs to a plan feature". Place it right after
// requireAuth in a router. A no-op unless ENFORCE_PLAN_GATING="true", so shipping
// the code changes nothing for anyone until the owner flips that switch.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import type { TenantContext } from "../auth/supabase";
import { apiError } from "../http";
import { FEATURES, PLAN_LABELS, gatingEnforced, planAllows, type FeatureKey, type PlanTier } from "./plans";

export function requireFeature(feature: FeatureKey): MiddlewareHandler<{ Bindings: Env; Variables: { tenant: TenantContext } }> {
  return async (c, next) => {
    if (gatingEnforced(c.env)) {
      const tenant = c.get("tenant");
      if (!planAllows(tenant.planTier, feature)) {
        const required = FEATURES[feature].minPlan as PlanTier;
        // 402 Payment Required — distinct from 403 (not allowed at all) and from the
        // 402 INSUFFICIENT_CREDITS (a metered call ran out), via its own error code.
        return apiError(c, 402, "PLAN_REQUIRED", `${FEATURES[feature].label} is part of the ${PLAN_LABELS[required]} plan`, {
          feature, required_plan: required, required_plan_label: PLAN_LABELS[required], current_plan: tenant.planTier,
        });
      }
    }
    await next();
  };
}
