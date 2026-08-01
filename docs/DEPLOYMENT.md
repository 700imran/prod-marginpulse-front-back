# Deployment

All infrastructure is defined as SAM/CloudFormation templates in
`infra/`. There is no Terraform, no CDK, no manual-console-only
resource — everything below is reproducible from these three files.

## Order of operations

### 1. DynamoDB table (`infra/dynamodb-table.yaml`)

Deploy first — every other stack depends on the table name it creates.

```bash
sam deploy --guided -t infra/dynamodb-table.yaml
```

Creates the single table + 3 GSIs (see `DATABASE_SCHEMA.md`) with
CloudWatch alarms on read/write throttle events.

### 2. API Lambda (`infra/api-template.yaml`)

```bash
aws ecr create-repository --repository-name marginpulse-api --region ap-south-1
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-south-1.amazonaws.com
docker build -f cmd/api/Dockerfile -t marginpulse-api .
docker tag marginpulse-api:latest <account-id>.dkr.ecr.ap-south-1.amazonaws.com/marginpulse-api:latest
docker push <account-id>.dkr.ecr.ap-south-1.amazonaws.com/marginpulse-api:latest
sam build -t infra/api-template.yaml
sam deploy --guided -t infra/api-template.yaml
```

Deploys one Lambda function (`marginpulse-api-go-<env>`, 512MB, 29s
timeout) behind an HTTP API (API Gateway v2, not REST API v1) plus an
SNS alarm topic.

**Docker build note**: the plain `docker build` (with the default
Dockerfile lookup) doesn't work correctly for this repo layout — always
build with an explicit `-f`:
```bash
docker build -f cmd/api/Dockerfile -t marginpulse-api .
docker build -f cmd/worker/Dockerfile -t marginpulse-worker .
```

### 3. Worker Lambdas + OCR Lambda + SQS queues (`infra/worker-template.yaml`)

```bash
aws ecr create-repository --repository-name marginpulse-worker --region ap-south-1
docker build -f cmd/worker/Dockerfile -t marginpulse-worker .
# ...tag+push same as above...

aws ecr create-repository --repository-name marginpulse-ocr-service --region ap-south-1
docker build -f ocr-service/Dockerfile -t marginpulse-ocr-service .
# ...tag+push same as above...

sam build -t infra/worker-template.yaml
sam deploy --guided -t infra/worker-template.yaml
```

This one template creates:
- **5 SQS queues** (+ 5 matching dead-letter queues), one per task
  type: OCR, reconciliation, GST sync, tax-identifier verification,
  bank-account verification.
- **4 Go worker Lambda functions**, each triggered by its own queue,
  each running the **same** `cmd/worker` container image — the
  per-task routing happens inside the Go binary (`dispatch()` in
  `cmd/worker/main.go` reads the `task` field from the SQS message
  body), not via separate container images per queue. Functions are
  split so each task type can be tuned independently (memory/timeout —
  GST sync gets a 150s timeout, tax-identifier verification gets 256MB
  and 30s, etc.), not because they run different code.
- **One Python OCR Lambda** (`marginpulse-ocr-service-<env>`, 1024MB —
  ONNXRuntime needs more headroom than the Go functions — 30s timeout),
  built from `ocr-service/Dockerfile`. The OCR worker function's IAM
  role is granted `lambda:InvokeFunction` on this function specifically
  (see `worker-template.yaml`'s `OcrServiceFunction` +
  the invoke policy attached to the OCR worker's role).
- CloudWatch alarms per queue (age of oldest message / DLQ depth).

### 4. Frontend

```bash
cd frontend
npm install
REACT_APP_API_URL=https://<your-api-gateway-url> npm run build
```

`REACT_APP_API_URL` is baked into the JS bundle **at build time** (CRA
behavior) — changing it requires a rebuild, not just a redeploy/restart.
Deploy the `build/` folder to any static host — Cloudflare Pages,
Vercel, or S3+CloudFront. No server-side component, no API routes live
in this repo.

## Required parameters / secrets at deploy time

See `.env.example` for the full list with comments. The ones SAM
prompts for via `--guided` (or you should set non-interactively in
CI): `RedisURL`, `FieldEncryptionKey`, `AnthropicApiKey` (optional —
only needed for the dashboard's plain-English insight),
`AlarmNotificationEmail`, `DynamoDBTableName` (output from step 1).

Everything else (JWT secrets, OAuth client IDs/secrets, GST API
credentials, WhatsApp/SMTP config, reconciliation thresholds) is a
plain Lambda environment variable set per-function in the templates —
edit the `Globals.Function.Environment.Variables` block or each
function's own `Environment` override in the relevant template.

## What's NOT automated yet

- No CI/CD pipeline defined in this repo (no `.github/workflows`, no
  buildspec) — deploys above are manual/CLI. See `ROADMAP.md`.
- No scheduled trigger (EventBridge rule) for
  `detect-missing-invoices` or `gst/sync` — both are currently
  request-triggered only. Adding a scheduled Lambda trigger to either
  is a small, well-scoped next task (see `ROADMAP.md`).
- Redis is assumed to already exist (e.g. a managed Redis add-on) —
  there's no `infra/redis.yaml`; `REDIS_URL` is a parameter, not a
  resource this repo provisions.
