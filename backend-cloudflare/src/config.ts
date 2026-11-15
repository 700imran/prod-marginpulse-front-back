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
  METRICS?: AnalyticsEngineDataset; // optional: Workers Analytics Engine ([[analytics_engine_datasets]] in wrangler.toml)

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

  TURNSTILE_SITE_KEY?: string;        // public Turnstile site key (var). Empty = captcha disabled
  TURNSTILE_SECRET?: string;          // Turnstile secret key (`wrangler secret put TURNSTILE_SECRET`)

  // --- capacity controls (all optional; see docs/CAPACITY.md) ---
  FREE_DOCS_PER_MONTH?: string;        // FREE plan: documents created per calendar month (default 300; "0" = unlimited)
  FREE_BANK_ROWS_PER_MONTH?: string;   // FREE plan: bank rows imported per calendar month (default 5000; "0" = unlimited)
  MAX_HEAVY_INFLIGHT?: string;         // concurrent uploads/imports/reconciles per isolate before shedding with 503 (default 8; "0" = off)

  CRON_MAX_TENANTS?: string;           // safety cap on tenants enqueued per daily run (default 200000)

  // --- optional UPI fallback payments (off unless UPI_FALLBACK_ENABLED="true"; see src/billing/upi.ts) ---
  UPI_FALLBACK_ENABLED?: string;
  UPI_VPA?: string;                   // manual mode: the VPA customers pay, e.g. marginpulse@okhdfcbank
  UPI_PAYEE_NAME?: string;            // shown in the customer's UPI app (default "MarginPulse")
  UPI_GATEWAY_BASE_URL?: string;      // gateway mode: your self-hosted upi-gateway, https://pay.example.com
  UPI_GATEWAY_API_KEY?: string;       // secret
  UPI_GATEWAY_API_SECRET?: string;    // secret
  UPI_GATEWAY_WEBHOOK_SECRET?: string; // secret — the LIVE webhook signing secret from the gateway dashboard

  // --- optional WhatsApp gateway (Baileys sidecar, extensions/whatsapp-gateway) ---
  WA_GATEWAY_NUMBER?: string;         // display only: the gateway's WhatsApp number (digits, with country code) users send LINK codes to
  WA_GATEWAY_URL?: string;            // https URL of the sidecar; used to SEND messages
  WA_GATEWAY_TOKEN?: string;          // secret — bearer token the Worker uses when calling the sidecar
  WA_GATEWAY_WEBHOOK_SECRET?: string; // secret — HMAC key the sidecar uses to sign inbound messages to the Worker

  // --- optional visitor tracking (consent-gated; see src/routes/track.ts) ---
  TRACKING_ORIGINS?: string;          // comma-separated marketing-site origins allowed to POST /api/v1/track/* (the app's FRONTEND_ORIGIN is always allowed)
  FPJS_SECRET_KEY?: string;           // Fingerprint *Server API* secret (wrangler secret). Empty = first-party random id only
  FPJS_API_BASE?: string;             // https://api.fpjs.io (global), https://ap.api.fpjs.io (Asia), https://eu.api.fpjs.io
  VISITOR_RETENTION_DAYS?: string;    // default 90

  // --- optional telemetry (all off unless set) ---
  OTLP_ENDPOINT?: string;             // e.g. https://otlp-gateway-prod-ap-south-1.grafana.net/otlp  or your collector URL
  OTLP_HEADERS?: string;              // "Authorization=Basic <base64 instanceId:token>" (secret)
  TELEMETRY_SALT?: string;            // salt for hashing tenant ids in logs/traces (secret)
  TRACE_SAMPLE_RATE?: string;         // 0..1, default 0.1 (errors and >1s requests are always traced)

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
  RAZORPAY_WEBHOOK_SECRET?: string;
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
