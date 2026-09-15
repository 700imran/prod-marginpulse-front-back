// Mirrors backend/internal/config/config.go's Config struct, minus
// everything Supabase Auth now owns (JWT secret rotation, OAuth client
// credentials for Google/Apple, refresh-token TTLs).

export interface Env {
  // --- bindings (wrangler.toml) ---
  DOCS_BUCKET: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  OCR_QUEUE: Queue;
  RECONCILE_QUEUE: Queue;
  GST_QUEUE: Queue;
  TAX_IDENTIFIER_QUEUE: Queue;
  BANK_ACCOUNT_QUEUE: Queue;

  // --- plain vars (wrangler.toml [vars]) ---
  ENVIRONMENT: string;
  SUPABASE_URL: string;
  UPSTASH_REDIS_REST_URL: string;
  GST_API_BASE_URL: string;
  ANTHROPIC_API_BASE_URL: string;
  ANTHROPIC_MODEL: string;             // config.go default: "claude-sonnet-4-20250514" — check this is still a live model string before deploying
  LLM_MAX_TOKENS: string;              // config.go default: "1024"
  AI_MAX_PROMPT_TOKENS: string;        // config.go default: "8000"
  AI_MAX_COMPLETION_TOKENS: string;    // config.go default: "2000"
  FRONTEND_ORIGIN: string;
  INGEST_EMAIL_ADDRESS: string;
  AI_INSIGHTS_DAILY_BUDGET_USD: string;

  // --- secrets (`wrangler secret put <NAME>`) ---
  SUPABASE_JWT_SECRET: string;        // Settings > API > JWT Secret in Supabase
  SUPABASE_SERVICE_ROLE_KEY: string;  // only used for the rare Supabase Admin API call (e.g. deleting an auth user)
  FIELD_ENCRYPTION_KEY: string;       // 32-byte base64 key for AES-256-GCM, replaces security.FieldEncryptionKey
  UPSTASH_REDIS_REST_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  GST_API_CLIENT_ID: string;      // empty string = graceful PENDING fallback, same as Go's cfg.GSTAPIClientID check
  GST_API_CLIENT_SECRET: string;
  GST_API_USERNAME: string;       // separate from client-id — used only by gstsync.ts's /authenticate call
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  RESEND_API_KEY: string;             // see src/email.ts — provider swap from the Go original's raw SMTP
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_APP_SECRET: string;        // Meta App Secret — verifies X-Hub-Signature-256 on inbound webhooks; empty = unverified fallback (logged)
  WHATSAPP_API_VERSION: string;       // e.g. "v19.0"
  WEBHOOK_INGEST_SECRET: string;      // shared secret checked against X-Webhook-Secret on the email-ingest webhook
}

export function isProd(env: Env): boolean {
  return env.ENVIRONMENT === "production";
}
