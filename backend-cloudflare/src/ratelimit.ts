import type { Env } from "./config";

// Replaces internal/ratelimit/ratelimit.go's go-redis (TCP) client.
// Workers can't hold the raw RESP/TCP connection go-redis used — Upstash's
// REST API covers the same handful of commands (INCR/EXPIRE/GET/SET/DEL)
// over plain fetch(), so the provider doesn't change, just the transport.
// You're already on Upstash per your existing setup, so this is a client
// swap, not a new dependency.

async function upstash(env: Env, ...command: (string | number)[]): Promise<any> {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash command failed: ${res.status}`);
  const json = (await res.json()) as { result: any };
  return json.result;
}

// --- Rate limiting: fixed window, same as ratelimit.go -------------------
export async function checkRateLimit(
  env: Env,
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ratelimit:${bucket}:${identifier}:${window}`;
  const count = await upstash(env, "INCR", key);
  if (count === 1) {
    await upstash(env, "EXPIRE", key, windowSeconds);
  }
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

// --- AI budget guard, replaces internal/aibudget/aibudget.go --------------
export async function checkAndIncrementAIBudget(env: Env, estimatedCostUSD: number): Promise<{ allowed: boolean; spentTodayUSD: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `ai_budget:${day}`;
  const spentCentsRaw = await upstash(env, "GET", key);
  const spentCents = spentCentsRaw ? parseInt(spentCentsRaw, 10) : 0;
  const budgetCents = Math.round(parseFloat(env.AI_INSIGHTS_DAILY_BUDGET_USD) * 100);
  const costCents = Math.round(estimatedCostUSD * 100);
  if (spentCents + costCents > budgetCents) {
    return { allowed: false, spentTodayUSD: spentCents / 100 };
  }
  const newTotal = await upstash(env, "INCRBY", key, costCents);
  await upstash(env, "EXPIRE", key, 172800); // 2 days, so a slow request near midnight still expires
  return { allowed: true, spentTodayUSD: newTotal / 100 };
}

// --- Slack OAuth CSRF state, replaces oauth/state.go's Redis-backed store -
// (Google/Apple no longer need this — Supabase Auth owns that OAuth flow
// entirely now.)
export async function storeOAuthState(env: Env, state: string, tenantId: string, ttlSeconds = 600): Promise<void> {
  await upstash(env, "SET", `oauth_state:${state}`, tenantId, "EX", ttlSeconds);
}

export async function consumeOAuthState(env: Env, state: string): Promise<string | null> {
  const tenantId = await upstash(env, "GET", `oauth_state:${state}`);
  if (tenantId) await upstash(env, "DEL", `oauth_state:${state}`);
  return tenantId;
}
