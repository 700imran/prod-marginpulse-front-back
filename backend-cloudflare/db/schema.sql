-- MarginPulse Pro — Supabase Postgres schema
-- Replaces the single-table DynamoDB design in backend/DYNAMODB_SCHEMA.md.
-- Every access pattern documented there was a plain `WHERE tenant_id = ?`
-- with an ORDER BY, plus a couple of uniqueness "guard items" — all of
-- that maps onto ordinary indexes and UNIQUE constraints here, so nothing
-- below is trying to be clever the way the Dynamo schema had to be.
--
-- Run this once against your Supabase project (SQL Editor, or `psql`
-- against the direct :5432 connection string — not the pooler — since
-- DDL doesn't play well with pgbouncer transaction mode).

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ============================================================================
-- tenants — one row per Supabase Auth user (auth.users.id is the tenant_id).
-- No password column: Supabase Auth owns credentials entirely.
-- ============================================================================
create table if not exists public.tenants (
  tenant_id            uuid primary key references auth.users(id) on delete cascade,
  business_name        text not null,
  display_name         text,
  owner_email          text not null,               -- denormalized from auth.users for convenient querying
  phone_number         text,
  country_code         text not null default 'IN',
  whatsapp_binding_phone text unique,
  ingest_email_alias   text unique,
  gstin_number         text,
  gst_registered       boolean not null default false,
  plan_tier            text not null default 'FREE' check (plan_tier in ('FREE','STARTER','GROWTH','ENTERPRISE')),
  is_active            boolean not null default true,
  is_platform_admin    boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_tenants_owner_email on public.tenants (owner_email);

-- When a paid plan (bought through payment_orders below) stops applying. NULL =
-- no expiry (FREE, or a plan set by hand, e.g. ENTERPRISE). The app treats an
-- expired plan as FREE at read time, so no scheduled job has to downgrade anyone.
alter table public.tenants add column if not exists plan_expires_at timestamptz;

-- ============================================================================
-- documents
-- ============================================================================
create table if not exists public.documents (
  document_id           uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(tenant_id) on delete cascade,
  doc_type              text not null default 'INVOICE' check (doc_type in ('INVOICE','RECEIPT','CREDIT_NOTE','OTHER')),
  original_filename     text not null,
  storage_key           text not null,               -- R2 object key (was s3_key)
  mime_type             text not null,
  file_size_bytes       bigint not null default 0,
  vendor_name           text,
  vendor_address        text,
  document_date         date,
  invoice_number        text,
  raw_total_amount      numeric(14,2),
  subtotal_amount       numeric(14,2),
  tax_amount            numeric(14,2),
  currency              text not null default 'INR',
  tax_identifier        text,                         -- extracted GSTIN, if any
  tax_type              text,
  ingest_channel        text not null default 'WEB_UPLOAD' check (ingest_channel in ('WEB_UPLOAD','WHATSAPP','EMAIL')),
  whatsapp_message_id   text,
  sender_phone          text,
  processing_status     text not null default 'PENDING' check (processing_status in ('PENDING','PARSED','RECONCILED')),
  ocr_confidence_score  numeric(5,4),
  ocr_raw_text          text,
  ocr_error_message     text,
  reconciliation_score  numeric(5,4),
  reconciliation_reason text,
  matched_bank_transaction_id uuid,
  gst_portal_status     text default 'PENDING' check (gst_portal_status in ('PENDING','NOT_FILED','MISMATCH','FILED')),
  job_id                text,
  duplicate_of_document_id uuid references public.documents(document_id),
  manually_corrected    boolean not null default false,
  corrected_by          text,
  corrected_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_documents_tenant_status on public.documents (tenant_id, processing_status);
create index if not exists idx_documents_tenant_created on public.documents (tenant_id, created_at desc);
create index if not exists idx_documents_tenant_gst on public.documents (tenant_id, gst_portal_status);
create index if not exists idx_documents_storage_key on public.documents (storage_key);

-- ============================================================================
-- bank_transactions
-- ============================================================================
create table if not exists public.bank_transactions (
  transaction_id        uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(tenant_id) on delete cascade,
  bank_reference        text,
  narration             text,
  transaction_date      date not null,
  value_date            date,
  debit_amount          numeric(14,2) not null default 0,
  credit_amount         numeric(14,2) not null default 0,
  closing_balance       numeric(14,2),
  currency              text not null default 'INR',
  reconciliation_status text not null default 'UNMATCHED' check (reconciliation_status in ('UNMATCHED','MATCHED','IGNORED')),
  matched_document_id   uuid references public.documents(document_id),
  match_score           numeric(5,4),
  source_filename       text,
  bank_name             text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_banktx_tenant_status_date on public.bank_transactions (tenant_id, reconciliation_status, transaction_date desc);

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard it: this file must be safe to
-- re-run on a database that already has it (that is how an existing deployment
-- is upgraded — see STATUS.md "Applying db/schema.sql to an existing database").
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_documents_matched_tx' and conrelid = 'public.documents'::regclass) then
    alter table public.documents
      add constraint fk_documents_matched_tx foreign key (matched_bank_transaction_id)
      references public.bank_transactions(transaction_id) deferrable initially deferred;
  end if;
end $$;

-- ============================================================================
-- tax_identifiers — UNIQUE constraint replaces the Dynamo "guard item" trick
-- ============================================================================
create table if not exists public.tax_identifiers (
  tax_identifier_id     uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(tenant_id) on delete cascade,
  id_type               text not null check (id_type in ('GSTIN','PAN','TAN','UDYAM')),
  id_value              text not null,
  label                 text,
  verification_status   text not null default 'PENDING' check (verification_status in ('PENDING','VERIFIED','FAILED','UNSUPPORTED')),
  verified_at           timestamptz,
  verification_error    text,
  verified_legal_name   text,
  verified_metadata     jsonb,
  is_primary            boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id_type, id_value)
);
create index if not exists idx_taxid_tenant on public.tax_identifiers (tenant_id);

-- ============================================================================
-- bank_accounts — account number stored encrypted (AES-256-GCM, see
-- src/security/fieldEncryption.ts), last4 kept in the clear for display
-- ============================================================================
create table if not exists public.bank_accounts (
  bank_account_id            uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references public.tenants(tenant_id) on delete cascade,
  bank_name                  text not null,
  account_holder_name        text not null,
  account_number_encrypted   text not null,
  account_number_last4       text not null,
  ifsc_code                  text not null,
  account_type               text not null default 'CURRENT' check (account_type in ('CURRENT','SAVINGS')),
  verification_status        text not null default 'PENDING' check (verification_status in ('PENDING','VERIFIED','FAILED','UNSUPPORTED')),
  verified_at                timestamptz,
  verification_error         text,
  verified_account_holder_name text,
  is_primary                 boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index if not exists idx_bankacct_tenant on public.bank_accounts (tenant_id);

-- ============================================================================
-- team_members
-- ============================================================================
create table if not exists public.team_members (
  team_member_id  uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(tenant_id) on delete cascade,
  invited_email   text not null,
  role            text not null default 'MEMBER' check (role in ('OWNER','ADMIN','MEMBER','VIEWER')),
  status          text not null default 'INVITED' check (status in ('INVITED','ACTIVE','REVOKED')),
  invite_token    text unique,
  invited_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  unique (tenant_id, invited_email)
);
create index if not exists idx_team_tenant on public.team_members (tenant_id);

-- ============================================================================
-- anomalies
-- ============================================================================
create table if not exists public.anomalies (
  anomaly_id            uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(tenant_id) on delete cascade,
  document_id           uuid references public.documents(document_id),
  related_transaction_id uuid references public.bank_transactions(transaction_id),
  anomaly_type          text not null check (anomaly_type in ('DUPLICATE_INVOICE','MISSING_INVOICE','TAX_PORTAL_MISMATCH','RECONCILIATION_MANUAL_REVIEW','RECONCILIATION_UNMATCHED','RECONCILIATION_FAILED')),
  severity              text not null default 'MEDIUM' check (severity in ('LOW','MEDIUM','HIGH','CRITICAL')),
  description           text not null,
  suggested_action      text,
  status                text not null default 'OPEN' check (status in ('OPEN','RESOLVED','DISMISSED')),
  resolved_at           timestamptz,
  resolved_by           text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_anomalies_tenant_status on public.anomalies (tenant_id, status);

-- ============================================================================
-- audit_log — append-only
-- ============================================================================
create table if not exists public.audit_log (
  audit_log_id  uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(tenant_id) on delete cascade,
  entity_type   text not null,
  entity_id     uuid not null,
  action        text not null,
  field_name    text,
  old_value     text,
  new_value     text,
  reason        text,
  actor_email   text not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_audit_tenant_entity on public.audit_log (tenant_id, entity_type, entity_id, created_at desc);

-- ============================================================================
-- settings — one row per tenant per category (was 3 item-types in Dynamo)
-- ============================================================================
create table if not exists public.reconciliation_settings (
  tenant_id                   uuid primary key references public.tenants(tenant_id) on delete cascade,
  fuzzy_vendor_matching       boolean not null default true,
  date_drift_tolerance_days   integer not null default 3,
  ocr_confidence_threshold    numeric(5,4) not null default 0.75,
  updated_at                  timestamptz not null default now()
);

create table if not exists public.notification_settings (
  tenant_id                     uuid primary key references public.tenants(tenant_id) on delete cascade,
  critical_itc_missing_alert    boolean not null default true,
  critical_itc_threshold_inr    numeric(14,2) not null default 50000,
  weekly_audit_summary          boolean not null default true,
  updated_at                    timestamptz not null default now()
);

create table if not exists public.integration_settings (
  tenant_id                    uuid primary key references public.tenants(tenant_id) on delete cascade,
  gst_auto_sync_enabled        boolean not null default false,
  gst_auto_sync_day_of_month   integer not null default 11,
  whatsapp_outbound_enabled    boolean not null default false,
  updated_at                   timestamptz not null default now()
);

-- ============================================================================
-- platform_settings — single row, platform-admin only.
-- NOTE: no Google/Apple OAuth client id/secret here anymore — those are
-- configured in the Supabase dashboard (Authentication > Providers) now
-- that Supabase Auth owns social login. This table only holds settings
-- that are genuinely this app's concern.
-- ============================================================================
create table if not exists public.platform_settings (
  id                        smallint primary key default 1 check (id = 1),
  ai_insights_enabled       boolean not null default true,
  whatsapp_ingest_enabled   boolean not null default false,
  email_ingest_enabled      boolean not null default false,
  razorpay_integration_on   boolean not null default false,
  stripe_integration_on     boolean not null default false,
  slack_integration_on      boolean not null default true,
  slack_client_id           text,
  slack_client_secret_encrypted text,
  slack_redirect_uri        text,
  new_signups_enabled       boolean not null default true,
  updated_at                timestamptz not null default now(),
  updated_by                text
);
insert into public.platform_settings (id) values (1) on conflict (id) do nothing;

-- ============================================================================
-- integrations — per-tenant third-party connections (Slack, Razorpay, Stripe)
-- ============================================================================
create table if not exists public.integrations (
  tenant_id             uuid not null references public.tenants(tenant_id) on delete cascade,
  provider              text not null check (provider in ('SLACK','RAZORPAY','STRIPE')),
  status                text not null default 'DISCONNECTED' check (status in ('DISCONNECTED','CONNECTED','ERROR')),
  api_key_encrypted     text,
  -- Encrypted JSON blob of the full credentials object (e.g.
  -- {"key_id":"...","key_secret":"..."} for Razorpay), used instead of
  -- api_key_encrypted for any provider needing more than one named
  -- credential field, so sync can split them back apart correctly.
  credentials_encrypted text,
  access_token_encrypted text,
  external_account_id   text,
  external_account_name text,
  last_error            text,
  connected_at          timestamptz,
  last_synced_at        timestamptz,
  primary key (tenant_id, provider)
);

-- ============================================================================
-- Auto-create a tenant row the first time a Supabase Auth user is seen.
-- This is a *fallback* — src/auth/supabase.ts also does this in the Worker
-- on first authenticated request, so app code doesn't depend on triggers
-- firing before the API call lands. Both paths are idempotent
-- (insert ... on conflict do nothing).
-- ============================================================================
create or replace function public.handle_new_auth_user()
returns trigger as $$
begin
  insert into public.tenants (tenant_id, business_name, owner_email, country_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'business_name', split_part(new.email, '@', 1)),
    new.email,
    coalesce(new.raw_user_meta_data->>'country_code', 'IN')
  )
  on conflict (tenant_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- ============================================================================
-- Usage-based billing — separates the SaaS subscription (tenants.plan_tier
-- above) from metered usage of expensive external APIs (GST portal, bank
-- verification, AI insights). See src/billing/ for the code that reads and
-- writes these tables; that's also where the credit-cost-per-operation and
-- allowance-per-plan numbers live (src/billing/pricing.ts) — nothing here
-- hardcodes a price.
--
-- credit_wallets — one row per tenant: current balance, whether overage
--   (spending past zero) is allowed, and the current monthly period.
-- credit_ledger  — append-only, immutable log of every balance change.
--   Every entry carries a unique (tenant_id, idempotency_key) so a retried
--   HTTP request or a redelivered queue message can never double-charge or
--   double-refund — see src/billing/credits.ts for how that's enforced.
-- usage_events   — a record of every metered call *attempt*, including ones
--   denied for insufficient credits. Not a source of truth for the wallet
--   balance (credit_ledger is) — this is the observability/analytics side.
-- ============================================================================
create table if not exists public.credit_wallets (
  tenant_id                  uuid primary key references public.tenants(tenant_id) on delete cascade,
  balance_credits            numeric(14,4) not null default 0,
  overage_allowed            boolean not null default false,
  monthly_allowance_credits  numeric(14,4) not null default 0,
  current_period_start       date not null default date_trunc('month', now())::date,
  low_balance_notified_at    timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint chk_wallet_balance_nonneg check (overage_allowed or balance_credits >= 0)
);

create table if not exists public.credit_ledger (
  ledger_id       uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(tenant_id) on delete cascade,
  entry_type      text not null check (entry_type in ('RESERVE','REFUND','ADJUSTMENT','PURCHASE','MONTHLY_GRANT')),
  amount_credits  numeric(14,4) not null,        -- signed: negative = removed from wallet, positive = added
  balance_after   numeric(14,4) not null,
  operation       text not null,                 -- e.g. 'GST_SYNC', 'BANK_ACCOUNT_VERIFY', 'AI_INSIGHT'
  reference_type  text,                           -- e.g. 'job'
  reference_id    text,                           -- job_id / entity id this entry relates to
  idempotency_key text not null,                  -- e.g. 'reserve:<job_id>' — enforces exactly-once processing
  correlation_id  text,
  description     text,
  created_by      text not null default 'system',
  created_at      timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index if not exists idx_credit_ledger_tenant_created on public.credit_ledger (tenant_id, created_at desc);

create table if not exists public.usage_events (
  usage_event_id     uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(tenant_id) on delete cascade,
  provider           text not null,               -- 'GST_API','BANK_VERIFY_API','ANTHROPIC', etc.
  operation          text not null,                -- 'GST_SYNC','TAX_IDENTIFIER_VERIFY','BANK_ACCOUNT_VERIFY','AI_INSIGHT'
  outcome            text not null check (outcome in ('SUCCESS','FAILED','REFUNDED')),
  credits_consumed   numeric(14,4) not null default 0,
  correlation_id     text not null,
  job_id             text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_usage_events_tenant_created on public.usage_events (tenant_id, created_at desc);

-- ============================================================================
-- payment_orders — one row per checkout we started with the payment provider
-- (Razorpay). The amount is fixed server-side when the row is created; a payment
-- only activates a plan if the provider reports exactly that amount for exactly
-- this order. status moves CREATED -> PAID once, guarded by a row lock, so a
-- webhook and a browser confirmation arriving together cannot double-apply.
-- ============================================================================
create table if not exists public.payment_orders (
  order_id            uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(tenant_id) on delete cascade,
  plan                text not null check (plan in ('STARTER','GROWTH','ENTERPRISE')),
  months              integer not null default 1 check (months between 1 and 12),
  amount_paise        bigint not null check (amount_paise > 0),
  currency            text not null default 'INR',
  status              text not null default 'CREATED' check (status in ('CREATED','PAID','FAILED')),
  razorpay_order_id   text not null unique,
  razorpay_payment_id text unique,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index if not exists idx_payment_orders_tenant on public.payment_orders (tenant_id, created_at desc);

-- Backfill: one wallet row per tenant that already existed when this
-- migration (re-)ran, so reserveCredits() never has to special-case a
-- missing wallet for a pre-existing tenant. New tenants get a wallet
-- lazily on first use (see ensureWallet() in src/billing/credits.ts).
insert into public.credit_wallets (tenant_id)
select tenant_id from public.tenants
on conflict (tenant_id) do nothing;

-- ============================================================================
-- Row-Level Security — defense-in-depth for tenant isolation.
--
-- Every application query already filters `WHERE tenant_id = ?` at the
-- repository layer (src/repository/*.ts) — that has NOT changed and
-- remains the primary correctness mechanism. RLS is a second, independent
-- layer: if a future repository function ever forgets that filter, or a
-- bug supplies the wrong tenant_id, the database itself still refuses to
-- return or modify another tenant's rows. db/rls_test.sql has an
-- automated, runnable proof of exactly that — run it against any
-- Postgres this file has been applied to (including a throwaway local
-- one) before trusting this section actually protects anything.
--
-- THIS ONLY PROTECTS ANYTHING IF THE WORKER CONNECTS AS A NON-SUPERUSER,
-- NON-BYPASSRLS ROLE. Superusers and BYPASSRLS roles ignore every policy
-- below, full stop — FORCE ROW LEVEL SECURITY notwithstanding. That
-- includes Supabase's default `postgres` role, which is what most
-- Hyperdrive connection strings use out of the box. See NEXT_STEPS.md's
-- RLS section for the one-time step of switching the Hyperdrive
-- connection string to the `app_user` role created below — until that
-- switch is made, everything in this section is inert (harmless, but
-- providing zero actual protection).
--
-- Three session variables, set by application code
-- (src/security/tenantContext.ts) rather than derived from anything a
-- client sends directly — see that file for exactly where each is set:
--   app.tenant_id         — set for every authenticated request and
--                            queue task to the one tenant it's allowed
--                            to touch.
--   app.is_platform_admin — set true/false from the verified tenant's
--                            own is_platform_admin column, on every
--                            request (middleware/auth.ts). routes/
--                            admin.ts's requirePlatformAdmin remains the
--                            actual gate on which routes reach here; this
--                            is a second layer, not a replacement.
--   app.system_context    — set narrowly and briefly, only around
--                            specific trusted server-only operations that
--                            aren't naturally scoped to one caller's
--                            tenant: resolving which tenant a WhatsApp/
--                            email webhook or an invite-token redemption
--                            belongs to (authorized by a signature,
--                            shared secret, or the token itself — never
--                            by tenant_id), and the daily cron sweep that
--                            must enumerate every tenant. Never set from
--                            a code path a client can reach without
--                            first passing that check.
-- ============================================================================

create or replace function public.app_current_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function public.app_is_privileged() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'false')::boolean
      or coalesce(nullif(current_setting('app.system_context', true), ''), 'false')::boolean
$$;

-- One non-superuser, non-BYPASSRLS role for the Worker's Hyperdrive
-- connection. Created with no password — set one with
-- `ALTER ROLE app_user WITH PASSWORD '...'` run directly against your
-- Supabase project (SQL Editor or psql), never committed to this file.
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user with login nosuperuser nobypassrls noreplication nocreatedb nocreaterole;
  end if;
end
$$;
grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant execute on function public.app_current_tenant_id() to app_user;
grant execute on function public.app_is_privileged() to app_user;

-- Standard tenant-isolation policy, applied identically to every
-- tenant-owned table. One shared name ("tenant_isolation") per table
-- keeps this idempotent (drop-and-recreate) across repeated runs of this
-- file, same convention as the rest of the file's `create ... if not
-- exists`/`create or replace`.
do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'documents', 'bank_transactions', 'tax_identifiers', 'bank_accounts',
    'team_members', 'anomalies', 'audit_log', 'reconciliation_settings',
    'notification_settings', 'integration_settings', 'integrations',
    'credit_wallets', 'credit_ledger', 'usage_events', 'payment_orders'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all using (tenant_id = public.app_current_tenant_id() or public.app_is_privileged()) with check (tenant_id = public.app_current_tenant_id() or public.app_is_privileged())',
      t
    );
  end loop;
end
$$;

-- platform_settings has no tenant_id (it's a single global row) — any
-- authenticated connection may read it (needed for e.g. the Slack OAuth
-- connect flow, which any tenant can use to reach the platform's shared
-- Slack app credentials), but only a platform admin or trusted system
-- code may write to it.
alter table public.platform_settings enable row level security;
alter table public.platform_settings force row level security;
drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read on public.platform_settings
  for select using (public.app_current_tenant_id() is not null or public.app_is_privileged());
drop policy if exists platform_settings_write on public.platform_settings;
create policy platform_settings_write on public.platform_settings
  for insert with check (public.app_is_privileged());
drop policy if exists platform_settings_update on public.platform_settings;
create policy platform_settings_update on public.platform_settings
  for update using (public.app_is_privileged()) with check (public.app_is_privileged());

-- ============================================================================
-- Data retention & deletion — see src/retention.ts for the grace-period
-- numbers and src/purge.ts for the actual purge logic; both are run by the
-- cron sweep in index.ts's scheduled() handler. Two independent soft-delete
-- markers, both nullable (null = not scheduled for deletion):
--
--   tenants.deletion_requested_at  — the whole account. Deliberately does
--     NOT touch is_active or otherwise restrict access during the grace
--     period: the account stays fully usable so cancelling the request is
--     as easy as using the product normally, same reasoning most consumer
--     "delete my account" flows use. After the grace period, the purge job
--     deletes the auth.users row via the Supabase Admin API, which cascades
--     (on delete cascade, see the tenants table above) through every
--     tenant-owned table in one step — R2 objects are cleaned up
--     separately first, since R2 isn't part of that cascade.
--   documents.deleted_at — a single document, restorable within its own
--     grace period. Only listDocumentsByTenant (the main user-facing list)
--     filters it out by default; other internal queries (reconciliation,
--     GST matching, exports) do not yet — see NEXT_STEPS.md.
-- ============================================================================
alter table public.tenants add column if not exists deletion_requested_at timestamptz;
alter table public.documents add column if not exists deleted_at timestamptz;
create index if not exists idx_tenants_deletion_requested on public.tenants (deletion_requested_at) where deletion_requested_at is not null;
create index if not exists idx_documents_deleted_at on public.documents (deleted_at) where deleted_at is not null;
