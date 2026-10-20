// changePassword now runs through Supabase (the Worker has no such endpoint) and
// the ROI calculator must hit the route the Worker actually serves.
jest.mock("./supabaseClient", () => ({
  supabase: { auth: { getSession: jest.fn(), signInWithPassword: jest.fn(), updateUser: jest.fn(), refreshSession: jest.fn(), onAuthStateChange: jest.fn(), signOut: jest.fn(() => Promise.resolve()) } },
}));
jest.mock("./security/tokenManager", () => ({ __esModule: true, default: { getAccessToken: () => "tok", clearTokens: jest.fn() }, tokenManager: { getAccessToken: () => "tok", clearTokens: jest.fn() } }));
jest.mock("./ocr", () => ({ getOcrLines: jest.fn() }));

import { changePassword, calculateROI } from "./api";
import { supabase } from "./supabaseClient";

const mockAuth = supabase.auth;

const session = (user) => mockAuth.getSession.mockResolvedValue({ data: { session: user ? { user } : null } });
beforeEach(() => { jest.clearAllMocks(); });

describe("changePassword", () => {
  const emailUser = { email: "a@b.in", app_metadata: { providers: ["email"] } };
  test("verifies the current password, then updates, and reports the success text the screen looks for", async () => {
    session(emailUser);
    mockAuth.signInWithPassword.mockResolvedValue({ error: null });
    mockAuth.updateUser.mockResolvedValue({ error: null });
    const r = await changePassword("old-pass", "new-pass-123");
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({ email: "a@b.in", password: "old-pass" });
    expect(mockAuth.updateUser).toHaveBeenCalledWith({ password: "new-pass-123" });
    expect(r.detail.toLowerCase()).toContain("successfully");
  });
  test("wrong current password: never updates", async () => {
    session(emailUser);
    mockAuth.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const r = await changePassword("wrong", "new-pass-123");
    expect(r.detail).toBe("Current password is incorrect");
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
  });
  test("Supabase rejecting the new password surfaces its reason, not 'successfully'", async () => {
    session(emailUser);
    mockAuth.signInWithPassword.mockResolvedValue({ error: null });
    mockAuth.updateUser.mockResolvedValue({ error: { message: "New password should be different from the old password." } });
    const r = await changePassword("old", "old");
    expect(r.detail).toMatch(/different/);
    expect(r.detail.toLowerCase()).not.toContain("successfully");
  });
  test("Google-only accounts get an explanation, and nothing is attempted", async () => {
    session({ email: "a@b.in", app_metadata: { providers: ["google"] } });
    const r = await changePassword("x", "y");
    expect(r.detail).toMatch(/Google/);
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
  });
  test("no session: asks to log in again", async () => {
    session(null);
    expect((await changePassword("x", "y")).detail).toMatch(/session has expired/);
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
  });
});

test("ROI calculator posts to the route the Worker serves", async () => {
  global.fetch = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ ok: 1 }) });
  await calculateROI({ monthly_invoice_volume: 10 });
  expect(fetch.mock.calls[0][0]).toMatch(/\/api\/v1\/roi$/);
  expect(fetch.mock.calls[0][1].method).toBe("POST");
});
