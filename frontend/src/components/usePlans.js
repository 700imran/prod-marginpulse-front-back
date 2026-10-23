// The tenant's plan + the plan/feature catalogue, loaded once for the whole app.
// Fails open: until it loads (or if it can't) `plans` is null and nothing is locked.
import { useState, useEffect, useCallback, useRef } from "react";
import { getBillingPlans } from "../api";
import { readCache, writeCache } from "../apiCache";

export function usePlans() {
  const [plans, setPlans] = useState(() => readCache("plans")?.data ?? null); // last-known, shown instantly
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getBillingPlans();
      if (!alive.current) return null;
      if (data && Array.isArray(data.plans) && data.features && data.currentPlan) {
        setPlans(data);
        setFailed(false);
        writeCache("plans", data);
        return data;
      }
    } catch { /* fall through */ }
    if (alive.current) setFailed(true);   // keep any cached plans on screen; the Billing page offers a retry
    return null;
  }, []);

  useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; }; }, [refresh]);
  return { plans, failed, refresh };
}
