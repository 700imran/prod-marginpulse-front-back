jest.mock("./supabaseClient", () => ({ supabase: { auth: { refreshSession: jest.fn(), getSession: jest.fn(() => Promise.resolve({ data: {} })), onAuthStateChange: jest.fn(), signOut: jest.fn(() => Promise.resolve()) } } }));
jest.mock("./security/tokenManager", () => ({ __esModule: true, default: { getAccessToken: () => "tok", clearTokens: jest.fn() }, tokenManager: { getAccessToken: () => "tok", clearTokens: jest.fn() } }));
jest.mock("./ocr", () => ({ getOcrLines: jest.fn() }));

const reply = (status, body) => ({ status, json: async () => body });

describe("plan-required handling", () => {
  beforeEach(() => { jest.resetModules(); global.fetch = jest.fn(); });
  test("a 402 PLAN_REQUIRED from any call tells the app shell, with details", async () => {
    const { listAnomalies } = require("./api");
    const seen = [];
    window.addEventListener("mp:plan-required", (e) => seen.push(e.detail));
    fetch.mockResolvedValue(reply(402, { success: false, error: { code: "PLAN_REQUIRED", message: "Tax Portal Sync is part of the Starter plan", details: { feature: "gst_sync", required_plan_label: "Starter" } } }));
    const r = await listAnomalies("OPEN");
    expect(r.error).toBe("Tax Portal Sync is part of the Starter plan");   // views still get a readable message
    expect(seen).toEqual([{ feature: "gst_sync", required_plan_label: "Starter" }]);
  });
  test("INSUFFICIENT_CREDITS (also 402) does NOT trigger the upgrade screen", async () => {
    const { listAnomalies } = require("./api");
    const seen = []; const h = (e) => seen.push(e); window.addEventListener("mp:plan-required", h);
    fetch.mockResolvedValue(reply(402, { error: { code: "INSUFFICIENT_CREDITS", message: "no credits" } }));
    await listAnomalies("OPEN");
    window.removeEventListener("mp:plan-required", h);
    expect(seen).toEqual([]);
  });
  test("billing calls use the shared helpers: plans via request(), checkout/verify keep the status", async () => {
    const { getBillingPlans, createCheckout, verifyPayment } = require("./api");
    fetch.mockResolvedValueOnce(reply(200, { currentPlan: "FREE" })).mockResolvedValueOnce(reply(200, { orderId: "o" })).mockResolvedValueOnce(reply(202, { status: "PENDING" }));
    expect(await getBillingPlans()).toEqual({ currentPlan: "FREE" });
    expect(await createCheckout("STARTER")).toEqual({ status: 200, body: { orderId: "o" } });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ plan: "STARTER" });     // only a plan name — no amount
    expect(await verifyPayment({ razorpay_order_id: "a", razorpay_payment_id: "b", razorpay_signature: "c", extra: "dropped" })).toEqual({ status: 202, body: { status: "PENDING" } });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ razorpay_order_id: "a", razorpay_payment_id: "b", razorpay_signature: "c" });
  });
});

describe("backend address", () => {
  const load = (env, nodeEnv) => {
    jest.resetModules();
    const old = { u: process.env.REACT_APP_API_URL, n: process.env.NODE_ENV };
    if (env === undefined) delete process.env.REACT_APP_API_URL; else process.env.REACT_APP_API_URL = env;
    process.env.NODE_ENV = nodeEnv;
    global.fetch = jest.fn().mockResolvedValue(reply(200, {}));
    const api = require("./api");
    process.env.REACT_APP_API_URL = old.u; process.env.NODE_ENV = old.n;
    return api;
  };
  test("production build with REACT_APP_API_URL missing OR empty falls back to the real backend instead of its own origin", async () => {
    for (const env of [undefined, ""]) {
      const api = load(env, "production");
      await api.getBillingPlans();
      expect(fetch.mock.calls[0][0]).toBe("https://api.marginpulse.in/api/v1/billing/plans");
    }
  });
  test("an explicit REACT_APP_API_URL always wins", async () => {
    const api = load("https://staging.example.com", "production");
    await api.getBillingPlans();
    expect(fetch.mock.calls[0][0]).toBe("https://staging.example.com/api/v1/billing/plans");
  });
  test("local dev (not production) keeps same-origin so a dev proxy works", async () => {
    const api = load(undefined, "development");
    await api.getBillingPlans();
    expect(fetch.mock.calls[0][0]).toBe("/api/v1/billing/plans");
  });
});
