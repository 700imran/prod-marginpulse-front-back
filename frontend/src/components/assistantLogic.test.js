import { buildHistory, describeError, isExpired, MAX_MESSAGE_CHARS } from "./assistantLogic";

describe("buildHistory", () => {
  it("sends only real user/assistant text — no errors, notices, results or cards", () => {
    const h = buildHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", kind: "error", content: "boom" },
      { role: "assistant", kind: "notice", content: "Okay — nothing was changed." },
      { role: "assistant", kind: "result", content: "Moved to trash." },
      { role: "user", content: "   " },
    ]);
    expect(h).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  });
  it("never includes a confirmation token", () => {
    const h = buildHistory([{ role: "user", content: "x" }, { role: "assistant", content: "y", confirmation_token: "SECRET" }]);
    expect(JSON.stringify(h)).not.toContain("SECRET");
  });
  it("keeps the newest turns and respects server limits", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const h = buildHistory(many);
    expect(h.length).toBeLessThanOrEqual(12);
    expect(h[h.length - 1].content).toBe("m39");
    const big = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "z".repeat(1900) }));
    expect(buildHistory(big).reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(12000);
  });
});

describe("describeError", () => {
  it("402 points to billing", () => expect(describeError({ status: 402, body: {} }).action).toBe("billing"));
  it("network failure", () => expect(describeError({ status: 0, body: null }).text).toMatch(/reach the server/));
  it("never shows raw server text for 5xx", () => {
    expect(describeError({ status: 502, body: { error: { message: "upstream 500 secret" } } }).text).not.toMatch(/secret/);
    expect(describeError({ status: 503, body: null }).text).toMatch(/temporarily unavailable/);
  });
  it("409 shows the server's reason", () => expect(describeError({ status: 409, body: { error: { message: "That document isn't in the trash." } } }).text).toMatch(/trash/));
  it("429 asks to wait", () => expect(describeError({ status: 429, body: {} }).text).toMatch(/busy/));
});

describe("isExpired", () => {
  it("treats missing/invalid expiry as expired", () => { expect(isExpired(undefined)).toBe(true); expect(isExpired("x")).toBe(true); });
  it("honours a small safety margin", () => {
    expect(isExpired(1000, 900_000)).toBe(false);
    expect(isExpired(1000, 996_000)).toBe(true);
  });
});

it("message limit matches the backend (2000)", () => expect(MAX_MESSAGE_CHARS).toBe(2000));
