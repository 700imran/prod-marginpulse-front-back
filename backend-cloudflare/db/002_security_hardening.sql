-- MarginPulse Pro — security hardening migration (idempotent; safe to re-run).
-- Run in the Supabase SQL Editor (or psql on the direct connection).
--
-- WHY: Supabase exposes every table in the `public` schema through its
-- PostgREST API to anyone holding the project's anon key — and that key ships
-- inside the frontend bundle. With RLS off, anyone could read or modify EVERY
-- tenant's documents, bank transactions, bank accounts and integration
-- credentials. This app never uses PostgREST (all data goes through the
-- Worker, which connects as the table owner and is unaffected), so the
-- correct policy is DENY-ALL for the API roles.

-- 1) Row Level Security ON for every app table (no policies = deny for anon/authenticated).
alter table public.tenants                enable row level security;
alter table public.documents              enable row level security;
alter table public.bank_transactions      enable row level security;
alter table public.tax_identifiers        enable row level security;
alter table public.bank_accounts          enable row level security;
alter table public.team_members           enable row level security;
alter table public.anomalies              enable row level security;
alter table public.audit_log              enable row level security;
alter table public.reconciliation_settings enable row level security;
alter table public.notification_settings  enable row level security;
alter table public.integration_settings   enable row level security;
alter table public.platform_settings      enable row level security;
alter table public.integrations           enable row level security;

-- 2) Belt and braces: remove table/sequence/function privileges from the API roles entirely.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

-- 3) The signup trigger runs as SECURITY DEFINER: pin its search_path so it can't be hijacked.
alter function public.handle_new_auth_user() set search_path = public, pg_temp;

-- 4) audit_log is append-only. UPDATE is always blocked; DELETE is blocked unless a
--    privileged maintenance session explicitly opts in (e.g. a documented erasure request):
--      begin; set local app.allow_audit_purge = 'on'; delete ...; commit;
create or replace function public.audit_log_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_log rows are immutable';
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.allow_audit_purge', true), 'off') <> 'on' then
    raise exception 'audit_log rows cannot be deleted';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update on public.audit_log
  for each row execute function public.audit_log_immutable();
drop trigger if exists audit_log_no_delete on public.audit_log;
create trigger audit_log_no_delete before delete on public.audit_log
  for each row execute function public.audit_log_immutable();

-- 5) Verification — every row below must show rls_enabled = true and no anon/authenticated grants:
--   select c.relname, c.relrowsecurity as rls_enabled
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r' order by 1;
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and grantee in ('anon','authenticated');   -- expect 0 rows
