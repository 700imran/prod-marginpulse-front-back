# MarginPulse WhatsApp gateway (temporary, zero-cost)

A small always-on Node service that keeps a **WhatsApp Web session** (via [Baileys](https://github.com/WhiskeySockets/Baileys), MIT)
logged in on a spare number. It forwards invoices that users send to that number to the MarginPulse Worker
(`POST /webhook/whatsapp-gateway`, HMAC-signed), and sends back the Worker's confirmation text.

Use it **for testing, or as a stop-gap while the official WhatsApp Cloud API isn't available**. It is not an official channel.

> **Read this before using it**
> * Baileys is an *unofficial* client. WhatsApp's terms prohibit unofficial clients and automated bulk messaging; **the number can be banned**.
>   Use a dedicated spare SIM, **never your main business number**, never send marketing/bulk messages.
> * It only handles 1:1 chats, only PDF/JPG/PNG files up to 15 MB, and only replies to numbers already bound to a MarginPulse account
>   (unknown senders get no reply). Replies are capped (5 per sender per hour, 20 messages/minute overall).
> * The session lives in `AUTH_DIR`. Keep it on a persistent volume and treat it like a password. If the phone unlinks the device, delete the
>   directory, restart and scan a new QR.
> * Tested here with fakes (message parsing, signing, retries, spool, reconnect/backoff, HTTP auth) and booted against the real library.
>   **A real QR pairing and real message delivery were not tested** (needs a phone) — do a manual end-to-end check before relying on it.

## Run it

```bash
cp .env.example .env            # fill in the three secrets
docker build -t marginpulse-wa-gateway .
docker run -d --name wa-gateway --restart unless-stopped --env-file .env -p 127.0.0.1:8787:8787 -v wa-data:/data marginpulse-wa-gateway
docker logs -f wa-gateway       # a QR appears; WhatsApp → Linked devices → Link a device
```

Or without Docker: `npm ci && node --env-file=.env src/server.js` (Node ≥ 20). Any small always-on machine works (a spare PC or
Raspberry Pi + a Cloudflare Tunnel is free). The sidecar only makes *outbound* HTTPS calls to the Worker, so it needs no public port;
expose `/metrics` only to your Prometheus.

## Worker side

```bash
cd backend-cloudflare
wrangler secret put WA_GATEWAY_WEBHOOK_SECRET   # same value as in .env
```

Users bind their number in the app (Profile → WhatsApp) exactly as with the Cloud API; the Worker maps sender → tenant.
`WA_GATEWAY_URL` / `WA_GATEWAY_TOKEN` on the Worker are only needed if you later want the Worker to *send* messages through `POST /send`.

## Endpoints (all but `/health` need `Authorization: Bearer $WA_GATEWAY_TOKEN`)

| | |
|---|---|
| `GET /health` | liveness (public): process is up, plus connection state |
| `GET /ready` | 200 only while WhatsApp is connected, else 503 |
| `GET /metrics` | Prometheus: `mp_wa_connection_up`, `mp_wa_messages_total{outcome}`, `mp_wa_forward_attempts_total{result}`, `mp_wa_spool_files`, `mp_wa_reconnects_total{reason}`, … |
| `GET /qr`, `/qr.svg` | pending pairing QR |
| `POST /send` | `{to: "919876543210", text: "…"}` |

## How failures are handled

* Worker unreachable / 5xx / 429 → up to 5 attempts with exponential backoff + jitter (honours `Retry-After`), re-signed each time.
* Still failing → the payload is **spooled to disk** and retried every minute for up to 24 h (`mp_wa_spool_files` shows the backlog). The
  Worker de-duplicates on the WhatsApp message id, so a retry after a lost response never creates a second document.
* 4xx (e.g. wrong secret) → not retried, logged loudly with the likely cause.
* WhatsApp disconnects → reconnect with backoff (max 60 s); `loggedOut` stops and logs what to do.

Suggested alerts: `mp_wa_connection_up == 0` for 10 min; `mp_wa_spool_files > 0` for 15 min; `rate(mp_wa_forward_attempts_total{result=~"rejected_.*"}[15m]) > 0`.
