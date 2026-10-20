import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  tenantId: "t-1",
  listAuditLog: vi.fn(),
  getBank: vi.fn(),
  updateVerification: vi.fn(),
  reserve: vi.fn(),
  queueSend: vi.fn(),
}));

vi.mock("../src/middleware/auth", () => ({
  requireAuth: async (c: any, next: any) => { c.set("tenant", { tenantId: h.tenantId }); c.set("sql", {}); await next(); },
}));
vi.mock("../src/repository/auditLog", () => ({ listAuditLog: h.listAuditLog }));
vi.mock("../src/repository/bankAccounts", () => ({
  createBankAccount: vi.fn(), listBankAccounts: vi.fn(), setPrimaryBankAccount: vi.fn(), deleteBankAccount: vi.fn(), findByLast4AndIFSC: vi.fn(),
  getBankAccountById: h.getBank, updateBankAccountVerification: h.updateVerification,
}));
vi.mock("../src/billing/guard", () => ({ reserveForOperation: h.reserve }));
vi.mock("../src/security/fieldEncryption", () => ({ encryptField: vi.fn(), last4: vi.fn() }));

import { auditLogRoutes } from "../src/routes/auditLog";
import { bankAccountRoutes } from "../src/routes/bankAccounts";

const env = { BANK_ACCOUNT_QUEUE: { send: h.queueSend } } as any;
const app = () => { const a = new Hono<any>(); a.route("/audit", auditLogRoutes); a.route("/bank", bankAccountRoutes); return a; };
const json = async (r: Response) => (await r.json()) as any;

beforeEach(() => {
  h.tenantId = "t-1";
  h.listAuditLog.mockReset().mockResolvedValue([{ auditLogId: "1" }]);
  h.getBank.mockReset().mockResolvedValue({ bankAccountId: "b1", bankName: "HDFC", accountNumberEncrypted: "SECRET-CIPHERTEXT", verificationStatus: "VERIFIED" });
  h.updateVerification.mockReset().mockResolvedValue(undefined);
  h.reserve.mockReset().mockResolvedValue({ ok: true, amount: 3, balanceAfter: 40 });
  h.queueSend.mockReset().mockResolvedValue(undefined);
});

describe("GET /audit-log", () => {
  it("returns { items } scoped to the caller's tenant, default limit 100", async () => {
    const r = await app().request("/audit", {}, env);
    expect(await json(r)).toEqual({ items: [{ auditLogId: "1" }] });
    expect(h.listAuditLog).toHaveBeenCalledWith({}, "t-1", { entityType: undefined, entityId: undefined, limit: 100 });
  });
  it("passes filters through and the tenant never comes from the query string", async () => {
    await app().request("/audit?entity_type=DOCUMENT&entity_id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&limit=200&tenant_id=other", {}, env);
    expect(h.listAuditLog).toHaveBeenCalledWith({}, "t-1", { entityType: "DOCUMENT", entityId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", limit: 200 });
  });
  it.each(["entity_type=document", "entity_type=DOC;DROP", "limit=0", "limit=abc", "limit=-5", "entity_id=abc", "entity_id=1;drop"])("rejects %s", async (qs) => {
    const r = await app().request(`/audit?${qs}`, {}, env);
    expect(r.status).toBe(400);
    expect(h.listAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST /bank-accounts/:id/reverify", () => {
  it("reserves credits, marks PENDING, enqueues once, returns the row without the encrypted number", async () => {
    const r = await app().request("/bank/b1/reverify", { method: "POST" }, env);
    expect(r.status).toBe(202);
    const b = await json(r);
    expect(b.bankAccountId).toBe("b1");
    expect(JSON.stringify(b)).not.toContain("SECRET-CIPHERTEXT");
    expect(h.reserve.mock.calls[0]![2]).toBe("BANK_ACCOUNT_VERIFY");
    expect(h.updateVerification).toHaveBeenCalledWith({}, "b1", "PENDING", null, null);
    expect(h.queueSend).toHaveBeenCalledTimes(1);
    expect(h.queueSend.mock.calls[0]![0]).toMatchObject({ task: "verify_bank_account_task", args: { tenant_id: "t-1", bank_account_id: "b1" }, credit_reservation: { operation: "BANK_ACCOUNT_VERIFY", amount: 3 } });
  });
  it("404 for an account that isn't the caller's, with no charge and no job", async () => {
    h.getBank.mockResolvedValue(null);
    const r = await app().request("/bank/nope/reverify", { method: "POST" }, env);
    expect(r.status).toBe(404);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.queueSend).not.toHaveBeenCalled();
  });
  it("402 when out of credits: stays as it was, nothing enqueued", async () => {
    h.reserve.mockResolvedValue({ ok: false, amount: 3, balanceAfter: 1 });
    const r = await app().request("/bank/b1/reverify", { method: "POST" }, env);
    expect(r.status).toBe(402);
    expect((await json(r)).error.details).toEqual({ credits_remaining: 1 });
    expect(h.updateVerification).not.toHaveBeenCalled();
    expect(h.queueSend).not.toHaveBeenCalled();
  });
});
