-- MarginPulse Pro — visitor tracking (idempotent; safe to re-run). Run in the Supabase SQL Editor.
-- One row per (site, visitor). `visits` counts SESSIONS (a new session starts after 30 min of silence), not page views.
-- Personal-data minimisation: last_ip holds only the NETWORK (/24 IPv4, /48 IPv6), never the full address; city is the
-- edge's approximate city; nothing here is ever joined to a tenant, name, phone or e-mail. Rows are purged after
-- VISITOR_RETENTION_DAYS (default 90) by the daily cron, and a visitor can erase their own row (DELETE /api/v1/track/visitor).
create table if not exists public.visitors (
  site        text        not null check (site in ('app', 'marketing')),
  visitor_id  text        not null,
  id_source   text        not null default 'first_party' check (id_source in ('first_party', 'fingerprint')),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  visits      integer     not null default 1,
  last_ip     text,
  city        text,
  country     text,
  device      text,
  browser     text,
  os          text,
  primary key (site, visitor_id)
);
create index if not exists idx_visitors_last_seen on public.visitors (last_seen);
create index if not exists idx_visitors_site_first_seen on public.visitors (site, first_seen);

-- Same stance as every other table (see 002_security_hardening.sql): Supabase's auto-generated REST API must not see it.
alter table public.visitors enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.visitors from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.visitors from authenticated';
  end if;
end $$;
