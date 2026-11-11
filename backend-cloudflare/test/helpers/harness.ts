// In-process test harness: the REAL Hono app + REAL Postgres, with a local JWKS server (so the
// real auth middleware runs) and in-memory queues that can be drained through the real consumer.
// Only used when TEST_DATABASE_URL is set; otherwise callers skip.
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import postgres from "postgres";
import { app } from "../../src/index.ts";
import { handleQueueBatch } from "../../src/queue/consumer.ts";

export const DB_URL = process.env.TEST_DATABASE_URL;

type Msg = { task: string; job_id: string; args: Record<string, any> };

class MemQueue {
  pending: Msg[] = [];
  sentTotal = 0;
  async send(m: Msg) { this.pending.push(m); this.sentTotal++; }
  async sendBatch(ms: { body: Msg }[]) { for (const m of ms) { this.pending.push(m.body); this.sentTotal++; } }
}

export interface Harness {
  env: any;
  queues: Record<string, MemQueue>;
  admin: ReturnType<typeof postgres>;
  newTenant(label?: string): Promise<{ tenantId: string; email: string; token: string }>;
  call(token: string, method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  drain(opts?: { maxRounds?: number }): Promise<{ processed: number; retried: number; failed: number }>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  if (!DB_URL) throw new Error("TEST_DATABASE_URL is not set");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "t1", alg: "ES256", use: "sig" };
  const server = http.createServer((req, res) => {
    if (req.url?.includes("jwks.json")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.method === "POST" && req.url === "/upstash") { req.resume(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: 1 })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const queues = { OCR_QUEUE: new MemQueue(), RECONCILE_QUEUE: new MemQueue(), GST_QUEUE: new MemQueue(), TAX_IDENTIFIER_QUEUE: new MemQueue(), BANK_ACCOUNT_QUEUE: new MemQueue() };
  const env: any = {
    ENVIRONMENT: "test", SUPABASE_URL: base, FRONTEND_ORIGIN: "https://app.marginpulse.in",
    UPSTASH_REDIS_REST_URL: `${base}/upstash`, UPSTASH_REDIS_REST_TOKEN: "x",
    HYPERDRIVE: { connectionString: DB_URL },
    GST_API_BASE_URL: "", GST_API_CLIENT_ID: "", GST_API_CLIENT_SECRET: "", GST_API_USERNAME: "",
    AI_INSIGHTS_DAILY_BUDGET_USD: "5.00", ...queues,
  };
  const admin = postgres(DB_URL, { max: 2 });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(Promise.resolve(p).catch(() => {})); }, passThroughOnException() {} };
  let ipSeq = 0;

  const h: Harness = {
    env, queues, admin,
    async newTenant(label = "t") {
      const tenantId = crypto.randomUUID();
      const email = `${label}-${tenantId.slice(0, 8)}@example.test`;
      await admin`insert into auth.users (id, email) values (${tenantId}, ${email})`;
      const token = await new SignJWT({ email, role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "t1" }).setSubject(tenantId)
        .setIssuer(`${base}/auth/v1`).setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return { tenantId, email, token };
    },
    async call(token, method, path, body, extraHeaders = {}) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "CF-Connecting-IP": `10.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...extraHeaders };
      let payload: BodyInit | undefined;
      if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
      const res = await app.fetch(new Request(`https://api.test${path}`, { method, headers, body: payload }), env, ctx as any);
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* csv etc. */ }
      await Promise.all(pending.splice(0));
      return { status: res.status, json, text, headers: res.headers };
    },
    async drain({ maxRounds = 50 } = {}) {
      let processed = 0, retried = 0, failed = 0;
      for (let round = 0; round < maxRounds; round++) {
        const batchMsgs: { q: MemQueue; m: Msg }[] = [];
        for (const q of Object.values(queues)) while (q.pending.length) batchMsgs.push({ q, m: q.pending.shift()! });
        if (batchMsgs.length === 0) break;
        const attempts = new Map<Msg, number>();
        const messages = batchMsgs.map(({ q, m }) => ({
          id: crypto.randomUUID(), body: m, timestamp: new Date(), attempts: ((m as any).__attempts ?? 0) + 1,
          ack() { processed++; },
          retry() { retried++; (m as any).__attempts = ((m as any).__attempts ?? 0) + 1; if ((m as any).__attempts < 6) q.pending.push(m); else failed++; },
        }));
        void attempts;
        await handleQueueBatch({ queue: "test", messages, ackAll() {}, retryAll() {} } as any, env);
        await Promise.all(pending.splice(0));
      }
      return { processed, retried, failed };
    },
    async close() { await Promise.all(pending.splice(0)); await admin.end(); server.close(); },
  };
  return h;
}
