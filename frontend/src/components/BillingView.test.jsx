import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import BillingView from "./BillingView";
import LockedFeature from "./LockedFeature";
import { createCheckout, verifyPayment } from "../api";

jest.mock("../api", () => ({ createCheckout: jest.fn(), verifyPayment: jest.fn() }));

const plansData = (over = {}) => ({
  currentPlan: "FREE", currentPlanLabel: "Free", planExpiresAt: null, gatingEnforced: true, paymentsEnabled: true,
  plans: [
    { id: "FREE", label: "Free", monthlyCredits: 50, priceInr: 0, purchasable: false, features: [] },
    { id: "STARTER", label: "Starter", monthlyCredits: 500, priceInr: 499, purchasable: true, features: ["gst_sync", "audit_log"] },
    { id: "GROWTH", label: "Pro", monthlyCredits: 2000, priceInr: 1499, purchasable: true, features: ["gst_sync", "audit_log", "team"] },
    { id: "ENTERPRISE", label: "Enterprise", monthlyCredits: 10000, priceInr: 4999, purchasable: true, features: ["gst_sync", "audit_log", "team"] },
  ],
  features: { gst_sync: { label: "Tax Portal Sync", minPlan: "STARTER", minPlanLabel: "Starter" }, audit_log: { label: "Audit Trail", minPlan: "STARTER", minPlanLabel: "Starter" }, team: { label: "Audit Team", minPlan: "GROWTH", minPlanLabel: "Pro" } },
  ...over,
});

// A controllable fake of Razorpay's checkout window.
let rzpOpts; let rzpHandlers;
beforeEach(() => {
  jest.clearAllMocks(); jest.useRealTimers(); rzpOpts = null; rzpHandlers = {};
  window.Razorpay = function (opts) { rzpOpts = opts; this.on = (ev, fn) => { rzpHandlers[ev] = fn; }; this.open = () => {}; };
});
afterAll(() => { delete window.Razorpay; });

const order = { keyId: "rzp_test_key", orderId: "order_1", amount: 49900, currency: "INR", plan: "STARTER", planLabel: "Starter", email: "me@x.in" };
const setup = (plans = plansData(), extra = {}) => {
  const props = { plans, onPlanChanged: jest.fn().mockResolvedValue(plans), onToast: jest.fn(), ...extra };
  render(<BillingView {...props} />);
  return props;
};
const clickUpgrade = async (label) => { await act(async () => { fireEvent.click(screen.getByText(label)); }); };

test("shows every plan with the server's prices and credits, and the current one marked", () => {
  setup();
  expect(screen.getByText("Current plan: Free")).toBeTruthy();
  expect(screen.getByTestId("plan-STARTER").textContent).toMatch(/₹499/);
  expect(screen.getByTestId("plan-GROWTH").textContent).toMatch(/₹1,499/);
  expect(screen.getByTestId("plan-ENTERPRISE").textContent).toMatch(/₹4,999/);
  expect(screen.getByTestId("plan-GROWTH").textContent).toMatch(/Audit Team/);
  expect(screen.getByTestId("plan-FREE").textContent).toMatch(/current/);
});

test("while plans are loading it shows a placeholder, never a blank page", () => {
  const { container } = render(<BillingView plans={null} />);
  expect(container.querySelector(".skeleton")).not.toBeNull();
});

test("if plans can't be loaded it says so and offers a retry (never a placeholder forever)", () => {
  const onRetry = jest.fn();
  render(<BillingView plans={null} loadFailed onRetry={onRetry} />);
  expect(screen.getByRole("alert").textContent).toMatch(/Couldn't load your plan/);
  fireEvent.click(screen.getByText("Try again"));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("payments off: prices are visible, buttons are disabled, and it says why", () => {
  setup(plansData({ paymentsEnabled: false, plans: plansData().plans.map((p) => ({ ...p, purchasable: false })) }));
  expect(screen.getByText(/Online payment isn't switched on yet/)).toBeTruthy();
  for (const b of screen.getAllByText("Not available yet")) expect(b.disabled).toBe(true);
});

test("a happy-path payment: only the plan NAME is sent; success is shown only after the server confirms", async () => {
  createCheckout.mockResolvedValue({ status: 200, body: order });
  verifyPayment.mockResolvedValue({ status: 200, body: { status: "ACTIVE", plan: "STARTER" } });
  const p = setup();
  await clickUpgrade("Upgrade to Starter");
  expect(createCheckout).toHaveBeenCalledWith("STARTER");
  expect(rzpOpts).toMatchObject({ key: "rzp_test_key", order_id: "order_1", amount: 49900, currency: "INR", prefill: { email: "me@x.in" } });
  expect(p.onToast).not.toHaveBeenCalledWith(expect.stringMatching(/now on/), "success");   // nothing claimed yet
  await act(async () => { await rzpOpts.handler({ razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" }); });
  expect(verifyPayment).toHaveBeenCalledWith({ razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" });
  expect(p.onPlanChanged).toHaveBeenCalled();
  expect(p.onToast).toHaveBeenCalledWith(expect.stringMatching(/now on Starter/), "success");
});

test("payment taken but server still confirming (202): tells the user, polls, and activates when the plan changes", async () => {
  jest.useFakeTimers();
  createCheckout.mockResolvedValue({ status: 200, body: order });
  verifyPayment.mockResolvedValue({ status: 202, body: { status: "PENDING" } });
  const p = setup();
  p.onPlanChanged.mockResolvedValueOnce(plansData()).mockResolvedValueOnce(plansData({ currentPlan: "STARTER" }));
  await clickUpgrade("Upgrade to Starter");
  await act(async () => { await rzpOpts.handler({ razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" }); });
  expect(screen.getByText(/Payment received — confirming it now/)).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(4100); });
  await act(async () => { jest.advanceTimersByTime(4100); });
  expect(p.onToast).toHaveBeenCalledWith("Your plan is now active.", "success");
  expect(screen.queryByText(/confirming it now/)).toBeNull();
});

test("a failed verification never says success, and tells the user what to do about a debit", async () => {
  createCheckout.mockResolvedValue({ status: 200, body: order });
  verifyPayment.mockResolvedValue({ status: 400, body: { error: { message: "payment could not be verified" } } });
  const p = setup();
  await clickUpgrade("Upgrade to Starter");
  await act(async () => { await rzpOpts.handler({ razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "bad" }); });
  expect(p.onToast).toHaveBeenCalledWith(expect.stringMatching(/payment could not be verified.*If money was taken.*contact support/), "error");
  expect(p.onToast).not.toHaveBeenCalledWith(expect.anything(), "success");
});

test("closing the payment window says nothing was charged; a Razorpay failure is reported", async () => {
  createCheckout.mockResolvedValue({ status: 200, body: order });
  const p = setup();
  await clickUpgrade("Upgrade to Starter");
  await act(async () => { rzpOpts.modal.ondismiss(); });
  expect(p.onToast).toHaveBeenCalledWith(expect.stringMatching(/haven't been charged/), "info");
  await clickUpgrade("Upgrade to Starter");
  await act(async () => { rzpHandlers["payment.failed"]({ error: { description: "Card declined" } }); });
  expect(p.onToast).toHaveBeenCalledWith("Payment failed: Card declined", "error");
});

test.each([
  [501, { error: { message: "x" } }, /isn't switched on/],
  [409, { error: { message: "You're already on Pro, which includes everything in Starter" } }, /already on Pro/],
  [502, { error: { message: "internal detail" } }, /Couldn't start the payment/],
  [0, null, /Couldn't start the payment/],
])("checkout %s is explained to the user (never raw server text for 5xx)", async (status, body, expected) => {
  createCheckout.mockResolvedValue({ status, body });
  const p = setup();
  await clickUpgrade("Upgrade to Starter");
  expect(p.onToast).toHaveBeenCalledWith(expect.stringMatching(expected), "error");
  expect(p.onToast.mock.calls[0][0]).not.toMatch(/internal detail/);
  expect(rzpOpts).toBeNull();                         // the payment window was not opened
});

test("double-clicking can't start two checkouts", async () => {
  let resolve; createCheckout.mockImplementation(() => new Promise((r) => { resolve = r; }));
  setup();
  const btn = screen.getByText("Upgrade to Starter");
  await act(async () => { fireEvent.click(btn); });
  await act(async () => { fireEvent.click(screen.getByText("Opening payment…", { selector: "button" })); });
  expect(createCheckout).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ status: 501, body: {} }); });
});

test("your own plan can be renewed; a lower plan shows as included and can't be bought", () => {
  setup(plansData({ currentPlan: "GROWTH", currentPlanLabel: "Pro", planExpiresAt: "2026-11-21T00:00:00Z" }));
  expect(screen.getByText("Renew — add a month")).toBeTruthy();
  expect(screen.getAllByText("Included in your plan").length).toBe(1);        // Starter
  expect(screen.getAllByText("Included in your plan")[0].disabled).toBe(true);
  expect(screen.getByText(/Active until/)).toBeTruthy();
  expect(screen.getByText("Upgrade to Enterprise")).toBeTruthy();
});

describe("LockedFeature", () => {
  test("explains what's locked and offers the upgrade; calls no API", () => {
    const onUpgrade = jest.fn();
    render(<LockedFeature plans={plansData()} feature="team" onUpgrade={onUpgrade} />);
    expect(screen.getAllByText("Audit Team").length).toBeGreaterThan(0);
    expect(screen.getByText(/part of the/).textContent).toMatch(/Pro plan.*You're on Free/);
    fireEvent.click(screen.getByText(/See plans & upgrade/));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
  test("renders nothing for an unknown feature rather than a broken card", () => {
    const { container } = render(<LockedFeature plans={plansData()} feature="nope" onUpgrade={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
