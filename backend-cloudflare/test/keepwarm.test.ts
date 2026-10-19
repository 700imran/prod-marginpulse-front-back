// The 5-minute keep-warm cron shares scheduled() with the daily sweep +
// retention purge. These tests pin down that the two can't be confused.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as string[],
  dbFails: false,
  redisFails: false,
  listAllTenants: vi.fn(),
  runRetentionSweep: vi.fn(),
  setPrivilegedContext: vi.fn(),
  setTenantContext: vi.fn(),
  reportError: vi.fn(),
  sqlEnd: vi.fn(),
}));

vi.mock("../src/db", () => ({
  getDb: () => {
    const tag = async (strings: TemplateStringsArray) => {
      h.queries.push(strings.join("?"));
      if (h.dbFails) throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
      return [{ "?column?": 1 }];
    };
    return Object.assign(tag, { end: h.sqlEnd, unsafe: async () => [] });
  },
}));
vi.mock("../src/ratelimit", () => ({
  upstash: async () => { if (h.redisFails) throw new Error("redis down"); return "PONG"; },
  checkRateLimit: async () => ({ allowed: true }), checkAndIncrementAIBudget: async () => ({ allowed: true }),
}));
vi.mock("../src/repository/tenants", async (orig) => ({ ...(await orig() as object), listAllTenants: h.listAllTenants }));
vi.mock("../src/purge", async (orig) => ({ ...(await orig() as object), runRetentionSweep: h.runRetentionSweep }));
vi.mock("../src/security/tenantContext", async (orig) => ({ ...(await orig() as object), setPrivilegedContext: h.setPrivilegedContext, setTenantContext: h.setTenantContext }));
vi.mock("../src/monitoring", () => ({ reportError: h.reportError }));

import worker from "../src/index";
import { KEEP_WARM_CRON } from "../src/warm";

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() });
const fire = (cron: string) => (worker as any).scheduled({ cron, scheduledTime: Date.now() }, { HYPERDRIVE: { connectionString: "x" } }, ctx());

beforeEach(() => {
  h.queries.length = 0; h.dbFails = false; h.redisFails = false;
  h.listAllTenants.mockReset().mockResolvedValue([]);
  h.runRetentionSweep.mockReset().mockResolvedValue({ documentsFailed: 0, tenantsFailed: 0 });
  h.setPrivilegedContext.mockReset(); h.setTenantContext.mockReset(); h.reportError.mockReset(); h.sqlEnd.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("scheduled(): keep-warm vs daily sweep", () => {
  it("the keep-warm cron string is the one in wrangler.toml", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain(`"${KEEP_WARM_CRON}"`);
    expect(toml).toContain('"0 3 * * *"');
  });

  it("keep-warm tick pings DB and touches NOTHING tenant-related", async () => {
    await fire(KEEP_WARM_CRON);
    expect(h.queries).toEqual(["select 1"]);
    expect(h.listAllTenants).not.toHaveBeenCalled();
    expect(h.runRetentionSweep).not.toHaveBeenCalled();
    expect(h.setPrivilegedContext).not.toHaveBeenCalled();
    expect(h.setTenantContext).not.toHaveBeenCalled();
    expect(h.sqlEnd).toHaveBeenCalledTimes(1); // connection released
  });

  it("the daily cron still runs the sweep and the retention purge", async () => {
    h.listAllTenants.mockResolvedValue([]);
    await fire("0 3 * * *");
    expect(h.setPrivilegedContext).toHaveBeenCalledTimes(1);
    expect(h.listAllTenants).toHaveBeenCalledTimes(1);
    expect(h.runRetentionSweep).toHaveBeenCalledTimes(1);
  });

  it("a down database is reported as a warning but never throws (no cron retry storm)", async () => {
    h.dbFails = true;
    await expect(fire(KEEP_WARM_CRON)).resolves.toBeUndefined();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![2]).toMatchObject({ severity: "warning", tags: { job: "keep_warm" } });
    expect(h.listAllTenants).not.toHaveBeenCalled();
  });

  it("Redis being down alone doesn't raise an alert (it degrades gracefully elsewhere too)", async () => {
    h.redisFails = true;
    await fire(KEEP_WARM_CRON);
    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe("GET /healthz leaks no internals", () => {
  it("returns ok flags only, even when dependencies fail with revealing errors", async () => {
    h.dbFails = true; h.redisFails = true;
    const res = await (worker as any).fetch(new Request("https://x/healthz"), { HYPERDRIVE: { connectionString: "x" }, ENVIRONMENT: "test", ALLOWED_ORIGINS: "https://app.example" }, ctx());
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|redis down/);
    expect(JSON.parse(text).checks.database).toEqual({ ok: false });
  });
});
