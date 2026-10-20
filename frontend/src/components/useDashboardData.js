// Data for the dashboard, loaded so that NOTHING waits on anything else.
//
// The old version awaited all five requests together (Promise.all) and showed
// only "Loading dashboard…" until the slowest one finished — and if any one of
// them threw (e.g. a timeout while the backend woke up) it never stopped
// loading at all. Here:
//   * every part is requested independently and fills its own section the
//     moment it arrives;
//   * a failed part marks only itself failed (retryable), never blanks the page;
//   * the last successful result is shown instantly from the local cache
//     (apiCache.js) while the live data loads behind it;
//   * the cache is only re-saved from LIVE responses, so showing old data can
//     never extend its own life.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  getDashboardFast, listAnomalies, listBankAccounts, listTaxIdentifiers,
  getDashboardInsights, getDashboardInsightText,
} from "../api";
import { readCache, writeCache } from "../apiCache";

const SLOW_AFTER_MS = 4000;

// part name -> [request, picks the piece of state out of a good response (or null if the response isn't usable)]
const PARTS = {
  summary: [getDashboardFast, (r) => (r?.summaryMetrics ? { summary: r } : null)],
  anomalies: [() => listAnomalies("OPEN"), (r) => (Array.isArray(r?.items) ? { anomalies: r.items } : null)],
  banks: [listBankAccounts, (r) => (Array.isArray(r) ? { bankAccountCount: r.length } : null)],
  taxIds: [listTaxIdentifiers, (r) => (Array.isArray(r) ? { taxIdentifierCount: r.length } : null)],
  insights: [getDashboardInsights, (r) => (r?.generatedAt ? { insights: r } : null)],
  insightText: [getDashboardInsightText, (r) => (typeof r?.plainEnglishInsight === "string" ? { insightText: r.plainEnglishInsight } : null)],
};

export function useDashboardData() {
  const cached = useMemo(() => readCache("dashboard")?.data ?? null, []);
  const [data, setData] = useState({
    summary: cached?.summary ?? null,
    anomalies: cached?.anomalies ?? null,        // null means "not loaded yet", [] means "loaded, none"
    bankAccountCount: cached?.bankAccountCount ?? null,
    taxIdentifierCount: cached?.taxIdentifierCount ?? null,
    insights: cached?.insights ?? null,
    insightText: cached?.insightText ?? "",
  });
  const [failed, setFailed] = useState({});
  const [slow, setSlow] = useState(false);
  const live = useRef(false);                    // true once any real response has arrived
  const mounted = useRef(true);
  const fromCache = Boolean(cached);

  const refresh = useCallback(() => {
    setFailed({});
    for (const [name, [call, pick]] of Object.entries(PARTS)) {
      Promise.resolve()
        .then(call)
        .then((res) => {
          if (!mounted.current) return;
          const patch = pick(res);
          if (patch) {
            live.current = true;
            setData((prev) => ({ ...prev, ...patch }));
          } else {
            setFailed((f) => ({ ...f, [name]: true }));
          }
        })
        .catch(() => { if (mounted.current) setFailed((f) => ({ ...f, [name]: true })); });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  // Persist only what came from the server this session.
  useEffect(() => { if (live.current) writeCache("dashboard", data); }, [data]);

  // "Still connecting…" if the headline numbers haven't appeared after a few seconds.
  const haveSummary = data.summary !== null;
  useEffect(() => {
    if (haveSummary || failed.summary) { setSlow(false); return undefined; }
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [haveSummary, failed.summary]);

  const removeAnomaly = useCallback((id) => {
    setData((prev) => ({ ...prev, anomalies: (prev.anomalies || []).filter((a) => a.anomalyId !== id) }));
  }, []);

  return { data, failed, slow, fromCache, refresh, removeAnomaly };
}
