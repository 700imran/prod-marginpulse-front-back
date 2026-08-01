# Local Setup

## Prerequisites

- Go 1.22+
- Node.js 18+ / npm
- Docker (for DynamoDB Local + Redis, and if you want to test the
  actual Lambda container images)
- Python 3.12 (only if you're changing `ocr-service/`)

## Backend

```bash
cd backend

# 1. DynamoDB Local (no AWS account needed for local dev)
docker run -p 8000:8000 amazon/dynamodb-local

# 2. Redis (rate limiting, token blocklist, AI budget, OAuth state)
docker run -p 6379:6379 redis:7

# 3. Copy env config
cp .env.example .env
# edit .env — at minimum set:
#   DYNAMODB_ENDPOINT_URL=http://localhost:8000
#   REDIS_URL=redis://localhost:6379/0
#   STORAGE_BACKEND=local (already the .env.example default)
#   JWT_SECRET_KEY / APP_SECRET_KEY / FIELD_ENCRYPTION_KEY — any random hex string for local dev

# 4. Create the local table (dynamodb-local doesn't auto-create it)
aws dynamodb create-table --endpoint-url http://localhost:8000 \
  --cli-input-json file://infra/dynamodb-table.yaml   # adapt: this file is
  # a CloudFormation template, not a raw create-table JSON — either hand-write
  # a matching create-table call from its Properties, or use `sam local`
  # tooling / localstack if you want the CFN template to apply as-is locally.

# 5. Verify everything compiles
go build ./...
go vet ./...

# 6. Run
go run ./cmd/localserver
# → http://localhost:8000 (plain net/http, identical handlers to the
#   Lambda deployment — no AWS API Gateway/Lambda runtime needed locally)
```

**Note on step 4**: `infra/dynamodb-table.yaml` is a CloudFormation/SAM
template, not a plain `aws dynamodb create-table` JSON body — the
straightforward local path is running it through `sam local` or
LocalStack rather than hand-translating it. If neither is set up yet,
translating its `AttributeDefinitions`/`KeySchema`/`GlobalSecondaryIndexes`
into a single `aws dynamodb create-table` call against
`localhost:8000` is a reasonable placeholder next task.

## OCR Lambda (only if you're changing `ocr-service/`)

```bash
cd backend/ocr-service
pip install -r requirements.txt
python3 -c "
import handler, base64, json
with open('/path/to/test-invoice.pdf', 'rb') as f:
    payload = {'file_base64': base64.b64encode(f.read()).decode(), 'mime_type': 'application/pdf'}
print(json.dumps(handler.handler(payload, None)))
"
```

This runs the exact same `handler()` function the Lambda would call —
no AWS needed to test OCR extraction against a real file locally.

## Frontend

```bash
cd frontend
npm install
# create .env.local (not committed):
echo "REACT_APP_API_URL=http://localhost:8000" > .env.local
npm start
# → http://localhost:3000, proxying API calls to the localserver above
```

## Verifying a full local loop

1. `go run ./cmd/localserver` (backend) + `npm start` (frontend) both
   running.
2. Register a test account through the UI (`/auth/register`).
3. Upload a real invoice PDF/image via the Documents tab.
4. **Note**: `run_ocr_pipeline` and `run_reconciliation` are normally
   dispatched via SQS in production. Locally, there's no SQS consumer
   running by default — check `cmd/localserver/main.go` for whether it
   stubs/inlines these tasks, or whether you need to invoke
   `cmd/worker`'s handler functions directly/manually while developing
   against a real queue (e.g. pointing `SQS_QUEUE_URL_OCR` etc. at a
   real AWS SQS queue even while everything else runs locally). This is
   the most likely rough edge a new engineer will hit first — see
   `TROUBLESHOOTING.md`.
