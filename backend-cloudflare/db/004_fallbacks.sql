-- MarginPulse Pro — fallback channels: UPI payments, WhatsApp-gateway number linking, webhook de-duplication (idempotent; safe to re-run).
-- Used only when UPI_FALLBACK_ENABLED="true" / the WhatsApp gateway is configured. Razorpay's flow does not touch these tables.
create table if not exists public.upi_payments (
  payment_id       uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(tenant_id) on delete cascade,
  plan             text        not null check (plan in ('starter', 'pro', 'enterprise')),
  amount_inr       integer     not null check (amount_inr > 0),
  reference        text        not null unique,          -- shown to the customer; sent as UPI `tr`; also our gateway client_order_id
  mode             text        not null check (mode in ('manual', 'gateway')),
  gateway_order_id text        unique,
  utr              text        unique,                   -- a bank reference can fund exactly one payment
  status           text        not null default 'PENDING' check (status in ('PENDING', 'SUBMITTED', 'PAID', 'REJECTED', 'EXPIRED')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       text
);
create index if not exists idx_upi_payments_tenant on public.upi_payments (tenant_id, created_at desc);
create index if not exists idx_upi_payments_review on public.upi_payments (created_at) where status = 'SUBMITTED';

-- Every webhook delivery (upi-gateway, whatsapp-gateway) is at-least-once; (source, event_id) is the dedupe key.
create table if not exists public.webhook_events (
  source      text        not null,
  event_id    text        not null,
  received_at timestamptz not null default now(),
  primary key (source, event_id)
);

-- Proves a person controls a WhatsApp number before it is bound to their account: the app shows a one-time code, the
-- person sends `LINK <code>` from that number to the gateway. Only a hash of the code is stored; codes live 15 minutes.
create table if not exists public.whatsapp_link_codes (
  code_hash  text        primary key,
  tenant_id  uuid        not null references public.tenants(tenant_id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_whatsapp_link_codes_tenant on public.whatsapp_link_codes (tenant_id);

alter table public.upi_payments enable row level security;
alter table public.whatsapp_link_codes enable row level security;
alter table public.webhook_events enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.upi_payments, public.webhook_events, public.whatsapp_link_codes from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.upi_payments, public.webhook_events, public.whatsapp_link_codes from authenticated';
  end if;
end $$;
