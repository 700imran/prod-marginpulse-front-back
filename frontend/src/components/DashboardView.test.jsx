// The dashboard must never present an empty page: shell + buttons immediately,
// each section filling in on its own, failures contained, and last-visit data
// shown instantly while live data loads.
import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import DashboardView from "./DashboardView";
import * as api from "../api";
import { writeCache, readCache, setUserIdGetter } from "../apiCache";

jest.mock("../api", () => ({
  getDashboardFast: jest.fn(), listAnomalies: jest.fn(), listBankAccounts: jest.fn(), listTaxIdentifiers: jest.fn(),
  getDashboardInsights: jest.fn(), getDashboardInsightText: jest.fn(),
  resolveAnomaly: jest.fn(), uploadDocument: jest.fn(), triggerReconciliation: jest.fn(),
  downloadReconciliationReport: jest.fn(), detectMissingInvoices: jest.fn(),
}));
jest.mock("./charts", () => ({ StatusDonut: () => <div data-testid="donut" />, RiskBarChart: () => <div data-testid="bars" /> }));

const never = () => new Promise(() => {});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const SUMMARY = { summaryMetrics: { totalUploadedDocuments: 42, successfullyReconciledCount: 30, unreconciledAnomaliesDetected: 5, gstMismatchFlagCount: 7 } };
const ANOMS = { items: [{ anomalyId: "a1", anomalyType: "DUPLICATE_INVOICE", severity: "HIGH", description: "Seen twice" }] };
const INSIGHTS = { generatedAt: "now", estimatedRecoverableItc: 12000, highestItcRiskToday: [], vendorsRequiringFollowUp: [{ vendorName: "Acme", totalTaxAtRisk: 5000, openIssueCount: 2 }], filingDeadlines: [] };

function allPending() {
  for (const f of ["getDashboardFast", "listAnomalies", "listBankAccounts", "listTaxIdentifiers", "getDashboardInsights", "getDashboardInsightText"]) api[f].mockImplementation(never);
}
const tenant = { gstinNumber: "27AAAAA0000A1Z5" };
const mount = () => render(<DashboardView tenant={tenant} onToast={jest.fn()} onNavigate={jest.fn()} />);

beforeEach(() => {
  jest.clearAllMocks(); localStorage.clear(); setUserIdGetter(() => "user-1"); jest.useRealTimers();
});

test("buttons and page structure are on screen immediately, with nothing loaded yet", () => {
  allPending();
  mount();
  expect(screen.queryByText("Loading dashboard…")).toBeNull();
  expect(screen.getByText("+ Upload Document")).toBeTruthy();
  expect(screen.getByText("Run Reconciliation")).toBeTruthy();
  expect(screen.getByText("Scan for Missing Invoices")).toBeTruthy();
  expect(screen.getByText("Download Report (CSV)")).toBeTruthy();
  expect(screen.getByText("Total Documents")).toBeTruthy();
  expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
});

test("each section fills in on its own: summary arrives while the rest are still loading", async () => {
  allPending();
  const s = deferred();
  api.getDashboardFast.mockImplementation(() => s.promise);
  mount();
  expect(screen.queryByText("42")).toBeNull();
  await act(async () => { s.resolve(SUMMARY); });
  expect(await screen.findByText("42")).toBeTruthy();
  expect(screen.getByText("30")).toBeTruthy();
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull(); // anomalies / insights still loading
});

test("one failing request neither blanks the page nor hangs it; the rest still render", async () => {
  allPending();
  api.getDashboardFast.mockResolvedValue(SUMMARY);
  api.listAnomalies.mockRejectedValue(new TypeError("Failed to fetch"));
  api.getDashboardInsights.mockResolvedValue(INSIGHTS);
  mount();
  expect(await screen.findByText("42")).toBeTruthy();
  expect(await screen.findByText("Couldn't load open anomalies.")).toBeTruthy();
  expect(await screen.findByText("Today's Priorities")).toBeTruthy();
  expect(screen.getByText("Run Reconciliation")).toBeTruthy();
});

test("insights failing still leaves its two action buttons available, with a retry", async () => {
  allPending();
  api.getDashboardFast.mockResolvedValue(SUMMARY);
  api.getDashboardInsights.mockRejectedValue(new Error("x"));
  mount();
  expect(await screen.findByText("Couldn't load today's priorities.")).toBeTruthy();
  expect(screen.getByText("Scan for Missing Invoices")).toBeTruthy();
  expect(screen.getByText("Download Report (CSV)")).toBeTruthy();
});

test("everything failing shows a clear message and Try again re-requests", async () => {
  for (const f of ["getDashboardFast", "listAnomalies", "listBankAccounts", "listTaxIdentifiers", "getDashboardInsights", "getDashboardInsightText"]) api[f].mockRejectedValue(new TypeError("Failed to fetch"));
  mount();
  expect(await screen.findByText(/couldn't reach the server/i)).toBeTruthy();
  api.getDashboardFast.mockResolvedValue(SUMMARY);
  const before = api.getDashboardFast.mock.calls.length;
  await act(async () => { fireEvent.click(screen.getAllByText("Try again")[0]); });
  expect(api.getDashboardFast.mock.calls.length).toBe(before + 1);
  expect(await screen.findByText("42")).toBeTruthy();
});

test("shows a 'still connecting' note after 4s of nothing, and removes it once data arrives", async () => {
  jest.useFakeTimers();
  allPending();
  const s = deferred();
  api.getDashboardFast.mockImplementation(() => s.promise);
  mount();
  expect(screen.queryByText(/Still connecting/)).toBeNull();
  await act(async () => { jest.advanceTimersByTime(4100); });
  expect(screen.getByText(/Still connecting/)).toBeTruthy();
  await act(async () => { s.resolve(SUMMARY); });
  expect(screen.queryByText(/Still connecting/)).toBeNull();
});

test("last visit's numbers appear instantly from cache, before any response", () => {
  writeCache("dashboard", { summary: SUMMARY, anomalies: ANOMS.items, bankAccountCount: 1, taxIdentifierCount: 1, insights: INSIGHTS, insightText: "Cached insight text." });
  allPending();
  mount();
  expect(screen.getByText("42")).toBeTruthy();
  expect(screen.getByText("Seen twice")).toBeTruthy();
  expect(screen.getByText("Cached insight text.")).toBeTruthy();
  expect(screen.queryByText(/Still connecting/)).toBeNull();
});

test("showing cached data does not refresh its own timestamp; a live response replaces it", async () => {
  writeCache("dashboard", { summary: SUMMARY, anomalies: [], bankAccountCount: 1, taxIdentifierCount: 1, insights: null, insightText: "" }, Date.now() - 3600_000);
  const saved0 = readCache("dashboard").savedAt;
  allPending();
  const s = deferred();
  api.getDashboardFast.mockImplementation(() => s.promise);
  mount();
  expect(readCache("dashboard").savedAt).toBe(saved0);
  await act(async () => { s.resolve({ summaryMetrics: { ...SUMMARY.summaryMetrics, totalUploadedDocuments: 43 } }); });
  expect(await screen.findByText("43")).toBeTruthy();
  await waitFor(() => expect(readCache("dashboard").savedAt).toBeGreaterThan(saved0));
  expect(readCache("dashboard").data.summary.summaryMetrics.totalUploadedDocuments).toBe(43);
});

test("another user's cached data is never shown", () => {
  writeCache("dashboard", { summary: SUMMARY, anomalies: [], bankAccountCount: 1, taxIdentifierCount: 1, insights: null, insightText: "" });
  setUserIdGetter(() => "user-2");
  allPending();
  mount();
  expect(screen.queryByText("42")).toBeNull();
});

test("AI insight is separate and non-blocking: numbers show first, paragraph appears later", async () => {
  allPending();
  const t = deferred();
  api.getDashboardFast.mockResolvedValue(SUMMARY);
  api.getDashboardInsightText.mockImplementation(() => t.promise);
  mount();
  expect(await screen.findByText("42")).toBeTruthy();
  expect(screen.queryByText("You have 7 GST gaps.")).toBeNull();
  await act(async () => { t.resolve({ plainEnglishInsight: "You have 7 GST gaps." }); });
  expect(await screen.findByText("You have 7 GST gaps.")).toBeTruthy();
});

test("resolving an anomaly removes it and the button works before other data has loaded", async () => {
  allPending();
  api.getDashboardFast.mockResolvedValue(SUMMARY);
  api.listAnomalies.mockResolvedValue(ANOMS);
  api.resolveAnomaly.mockResolvedValue({ status: "RESOLVED" });
  mount();
  await screen.findByText("Seen twice");
  await act(async () => { fireEvent.click(screen.getByText("Mark Resolved")); });
  expect(api.resolveAnomaly).toHaveBeenCalledWith("a1");
  await waitFor(() => expect(screen.queryByText("Seen twice")).toBeNull());
});

test("Run Reconciliation works immediately and reports failure instead of doing nothing", async () => {
  allPending();
  const onToast = jest.fn();
  api.triggerReconciliation.mockResolvedValue({ error: "Not enough credits" });
  render(<DashboardView tenant={tenant} onToast={onToast} onNavigate={jest.fn()} />);
  await act(async () => { fireEvent.click(screen.getByText("Run Reconciliation")); });
  expect(onToast).toHaveBeenCalledWith("Not enough credits", "error");
});

test("the setup guide doesn't flash as 'not done' before its data is known", async () => {
  allPending();
  const s = deferred();
  api.getDashboardFast.mockImplementation(() => s.promise);
  mount();
  expect(screen.queryByText("Upload your first invoice or bill")).toBeNull();
});
