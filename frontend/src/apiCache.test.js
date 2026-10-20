import { readCache, writeCache, clearAllCaches, setUserIdGetter, userIdFromToken, MAX_AGE_MS } from "./apiCache";

const jwt = (payload) => `h.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

beforeEach(() => { localStorage.clear(); setUserIdGetter(() => "user-1"); });

test("round-trips data for the current user", () => {
  writeCache("dashboard", { a: 1 });
  expect(readCache("dashboard").data).toEqual({ a: 1 });
});
test("one user's cache is never returned for another user", () => {
  writeCache("dashboard", { secret: "u1-data" });
  setUserIdGetter(() => "user-2");
  expect(readCache("dashboard")).toBeNull();
});
test("with no known user nothing is read or written", () => {
  setUserIdGetter(() => null);
  writeCache("dashboard", { a: 1 });
  expect(localStorage.length).toBe(0);
  expect(readCache("dashboard")).toBeNull();
});
test("entries older than 24h are ignored", () => {
  writeCache("dashboard", { a: 1 }, 1_000_000);
  expect(readCache("dashboard", 1_000_000 + MAX_AGE_MS - 1)).not.toBeNull();
  expect(readCache("dashboard", 1_000_000 + MAX_AGE_MS + 1)).toBeNull();
});
test("an entry dated in the future (clock tampering) is ignored", () => {
  writeCache("dashboard", { a: 1 }, 10_000_000);
  expect(readCache("dashboard", 1_000_000)).toBeNull();
});
test("corrupt or hostile stored values degrade to a miss, never throw", () => {
  writeCache("dashboard", { a: 1 });
  const key = Object.keys(localStorage).find((k) => k.includes("dashboard"));
  for (const bad of ["not json", "null", "{}", '{"savedAt":"x"}', "[]"]) {
    localStorage.setItem(key, bad);
    expect(() => readCache("dashboard")).not.toThrow();
    expect(readCache("dashboard")).toBeNull();
  }
});
test("clearAllCaches removes every user's cache entries and nothing else", () => {
  writeCache("dashboard", { a: 1 });
  setUserIdGetter(() => "user-2");
  writeCache("profile", { b: 2 });
  localStorage.setItem("mp_onboarding_dismissed", "1");
  clearAllCaches();
  expect(Object.keys(localStorage)).toEqual(["mp_onboarding_dismissed"]);
});
test("a storage that throws (private mode / quota) never breaks callers", () => {
  const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => writeCache("dashboard", { a: 1 })).not.toThrow();
  spy.mockRestore();
});
test("userIdFromToken reads sub, and tolerates garbage", () => {
  expect(userIdFromToken(jwt({ sub: "abc-123" }))).toBe("abc-123");
  for (const g of ["", "x", "a.b.c", "a..c", jwt({ nosub: 1 })]) expect(userIdFromToken(g)).toBeNull();
});
