// Regression guard for a production-blocking bug: a module-level `crypto.randomUUID()` (the telemetry
// Registry) typechecked, passed unit tests and `wrangler deploy --dry-run`, but crashed the Worker at
// startup on Cloudflare, so Workers Builds rejected the upload. This test loads every module under the
// same global-scope rule the Workers runtime enforces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("the Worker loads without generating random values in global scope", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "test/helpers/global-scope-check.mts"], { encoding: "utf8", timeout: 60000 });
  assert.match(r.stdout, /GLOBAL_SCOPE_OK/, `Worker failed to load in global scope:\n${r.stderr.split("\n").slice(0, 8).join("\n")}`);
});
