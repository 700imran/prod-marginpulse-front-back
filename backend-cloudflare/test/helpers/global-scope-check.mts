// Imports the whole Worker the way the Workers runtime does at upload/start time — in GLOBAL scope,
// where random values are forbidden ("Disallowed operation called within global scope", error 10021).
// Fails if any module generates randomness while loading.
const forbid = (name: string) => () => { throw new Error(`Disallowed operation in global scope: ${name}()`); };
Object.defineProperty(globalThis.crypto, "randomUUID", { value: forbid("crypto.randomUUID"), configurable: true });
Object.defineProperty(globalThis.crypto, "getRandomValues", { value: forbid("crypto.getRandomValues"), configurable: true });
await import("../../src/index.ts");
console.log("GLOBAL_SCOPE_OK");
