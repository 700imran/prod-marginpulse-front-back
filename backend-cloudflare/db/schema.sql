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

alter table public.documents
  add constraint fk_documents_matched_tx foreign key (matched_bank_transaction_id)
  references public.bank_transactions(transaction_id) deferrable initially deferred;

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
  insert into public.tenants (tenant_id, business_name, owner_email)
  values (new.id, coalesce(new.raw_user_meta_data->>'business_name', split_part(new.email, '@', 1)), new.email)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();
