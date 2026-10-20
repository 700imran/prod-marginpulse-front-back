// GET requests wait out and retry a waking backend; writes never auto-retry.
jest.mock("./supabaseClient", () => ({ supabase: { auth: { refreshSession: jest.fn(), getSession: jest.fn(() => Promise.resolve({ data: {} })), onAuthStateChange: jest.fn(), signOut: jest.fn(() => Promise.resolve()) } } }));
jest.mock("./security/tokenManager", () => ({ __esModule: true, default: { getAccessToken: () => "tok", clearTokens: jest.fn() }, tokenManager: { getAccessToken: () => "tok", clearTokens: jest.fn() } }));

jest.mock("./ocr", () => ({ getOcrLines: jest.fn() }));

import { listAnomalies, triggerReconciliation, _retryConfig } from "./api";

const ok = (body, status = 200) => ({ status, json: async () => body });

beforeEach(() => { _retryConfig.delaysMs = [1, 1]; _retryConfig.timeoutMs = 50; global.fetch = jest.fn(); });

test("GET: retries network failures and then succeeds", async () => {
  fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(ok({ items: [1] }));
  expect(await listAnomalies("OPEN")).toEqual({ items: [1] });
  expect(fetch).toHaveBeenCalledTimes(3);
});
test("GET: retries 503 (backend waking) and then succeeds", async () => {
  fetch.mockResolvedValueOnce(ok({}, 503)).mockResolvedValueOnce(ok({ items: [] }));
  expect(await listAnomalies("OPEN")).toEqual({ items: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("GET: after the retries are used up it throws the network error (same as before)", async () => {
  fetch.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(listAnomalies("OPEN")).rejects.toThrow("Failed to fetch");
  expect(fetch).toHaveBeenCalledTimes(3);
});
test("GET: a hung request is aborted after the timeout and retried", async () => {
  fetch.mockImplementationOnce((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))))
        .mockResolvedValueOnce(ok({ items: [] }));
  expect(await listAnomalies("OPEN")).toEqual({ items: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("GET: ordinary error statuses (404/500) are NOT retried", async () => {
  fetch.mockResolvedValue(ok({ error: { code: "NOT_FOUND", message: "nope" } }, 404));
  const r = await listAnomalies("OPEN");
  expect(r.error).toBe("nope");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("writes (POST) are never auto-retried — repeating one could do the thing twice", async () => {
  fetch.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(triggerReconciliation()).rejects.toThrow("Failed to fetch");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  fetch.mockResolvedValue(ok({}, 503));
  await triggerReconciliation();
  expect(fetch).toHaveBeenCalledTimes(1);
});
