-- db/rls_test.sql
--
-- Automated proof that the Row-Level Security policies in schema.sql
-- actually isolate tenants — not just that they exist, that they hold up
-- against exactly the mistake they're meant to catch (a query that has,
-- or is given, the wrong tenant_id).
--
-- Run this after applying schema.sql, against any Postgres — including a
-- disposable local one, which is how this file itself was written and
-- verified:
--
--   psql "<connection string, as a superuser/owner role>" \
--        -v ON_ERROR_STOP=1 -f db/rls_test.sql
--
-- Every check is a DO block that RAISE EXCEPTIONs — aborting the whole
-- script with a non-zero exit code — the moment isolation doesn't hold.
-- A clean run ends with "ALL RLS TESTS PASSED" and exit code 0. Wire that
-- into CI as a merge gate on any change to schema.sql: this is the kind
-- of regression (a dropped policy, a role accidentally granted
-- BYPASSRLS) that's easy to introduce without noticing and expensive to
-- find out about the hard way.
--
-- Non-destructive: everything this script creates lives inside one
-- transaction that's rolled back at the end, so it's safe to run
-- repeatably against a database with real tenants in it, not just a
-- throwaway one.
--
-- Prerequisite: schema.sql has already been applied, including the
-- app_user role and every tenant_isolation policy.

begin;

-- Two disposable test tenants, created the way the real app creates
-- them — via auth.users, so handle_new_auth_user's trigger (itself
-- SECURITY DEFINER, bypassing RLS by design, same as it does for every
-- real signup) creates the public.tenants rows.
insert into auth.users (id, email)
values ('99990000-0000-0000-0000-000000000001', 'rls-test-tenant-a@example.invalid');
insert into auth.users (id, email)
values ('99990000-0000-0000-0000-000000000002', 'rls-test-tenant-b@example.invalid');

do $$
begin
  if not exists (select 1 from public.tenants where tenant_id = '99990000-0000-0000-0000-000000000001') then
    raise exception 'setup failed: tenant A was not created — is the on_auth_user_created trigger installed?';
  end if;
  if not exists (select 1 from public.tenants where tenant_id = '99990000-0000-0000-0000-000000000002') then
    raise exception 'setup failed: tenant B was not created — is the on_auth_user_created trigger installed?';
  end if;
end
$$;

-- One document per tenant, inserted as the superuser/owner this script
-- connects as (bypasses RLS — correct for fixture setup; the point of
-- this script is to test *app_user*'s view, not the owner's).
insert into public.documents (document_id, tenant_id, doc_type, original_filename, storage_key, mime_type)
values
  ('99990000-0000-0000-0000-0000000000a1', '99990000-0000-0000-0000-000000000001', 'INVOICE', 'a.pdf', 'rls-test/a', 'application/pdf'),
  ('99990000-0000-0000-0000-0000000000b1', '99990000-0000-0000-0000-000000000002', 'INVOICE', 'b.pdf', 'rls-test/b', 'application/pdf');

-- From here on, run as app_user — the same non-superuser, non-BYPASSRLS
-- role the Worker's Hyperdrive connection uses in production. SET ROLE
-- (not SET SESSION AUTHORIZATION) so the transaction rollback at the end
-- cleanly reverts it.
set role app_user;

-- Test 1 — fail closed. No app.tenant_id set at all yet: must see
-- nothing, not everything. This is the single most important property
-- of the whole scheme — the default state denies, it does not
-- accidentally allow.
do $$
declare n int;
begin
  select count(*) into n from public.documents
    where document_id in ('99990000-0000-0000-0000-0000000000a1', '99990000-0000-0000-0000-0000000000b1');
  if n <> 0 then raise exception 'FAIL (fail-closed): expected 0 visible documents with no tenant context set, saw %', n; end if;
  raise notice 'PASS: fail-closed with no tenant context set';
end
$$;

-- Test 2 — a tenant sees exactly its own row.
select set_config('app.tenant_id', '99990000-0000-0000-0000-000000000001', false);
do $$
declare n int;
begin
  select count(*) into n from public.documents where document_id = '99990000-0000-0000-0000-0000000000a1';
  if n <> 1 then raise exception 'FAIL: tenant A cannot see its own document (saw %)', n; end if;
  raise notice 'PASS: tenant A sees its own document';
end
$$;

-- Test 3 — the core proof. Tenant A's context is set, but the query
-- explicitly asks for tenant B's row by id — simulating exactly the bug
-- this whole layer exists to catch (a repository function that forgot,
-- or was given, the wrong tenant_id). Must still return nothing.
do $$
declare n int;
begin
  select count(*) into n from public.documents where document_id = '99990000-0000-0000-0000-0000000000b1';
  if n <> 0 then raise exception 'FAIL (cross-tenant SELECT): tenant A''s context could read tenant B''s document (saw %)', n; end if;
  raise notice 'PASS: tenant A cannot read tenant B''s document even when explicitly queried by id';
end
$$;

-- Test 4 — cross-tenant UPDATE is blocked the same way.
do $$
declare affected int;
begin
  update public.documents set original_filename = 'hacked.pdf' where document_id = '99990000-0000-0000-0000-0000000000b1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL (cross-tenant UPDATE): tenant A''s context updated tenant B''s document'; end if;
  raise notice 'PASS: tenant A cannot update tenant B''s document';
end
$$;

-- Test 5 — cross-tenant INSERT is blocked by the WITH CHECK clause:
-- inserting a row *stamped* with tenant B's id while tenant A's context
-- is active must be rejected outright, not silently re-stamped or
-- silently dropped.
do $$
begin
  begin
    insert into public.documents (document_id, tenant_id, doc_type, original_filename, storage_key, mime_type)
    values ('99990000-0000-0000-0000-0000000000c1', '99990000-0000-0000-0000-000000000002', 'INVOICE', 'c.pdf', 'rls-test/c', 'application/pdf');
    raise exception 'FAIL (cross-tenant INSERT): tenant A''s context was allowed to insert a row stamped as tenant B';
  exception
    when insufficient_privilege or check_violation then
      raise notice 'PASS: tenant A cannot insert a row stamped as tenant B (%)', sqlerrm;
  end;
end
$$;

-- Test 6 — switching context to tenant B flips visibility correctly:
-- proves this follows whichever tenant is currently set, not a blanket
-- allow or deny.
select set_config('app.tenant_id', '99990000-0000-0000-0000-000000000002', false);
do $$
declare n_b int; n_a int;
begin
  select count(*) into n_b from public.documents where document_id = '99990000-0000-0000-0000-0000000000b1';
  select count(*) into n_a from public.documents where document_id = '99990000-0000-0000-0000-0000000000a1';
  if n_b <> 1 then raise exception 'FAIL: tenant B cannot see its own document'; end if;
  if n_a <> 0 then raise exception 'FAIL: tenant B can see tenant A''s document'; end if;
  raise notice 'PASS: switching context to tenant B flips visibility correctly';
end
$$;

-- Test 7 — platform-admin bypass sees across tenants, only while set.
select set_config('app.tenant_id', '', false);
select set_config('app.is_platform_admin', 'true', false);
do $$
declare n int;
begin
  select count(*) into n from public.documents
    where document_id in ('99990000-0000-0000-0000-0000000000a1', '99990000-0000-0000-0000-0000000000b1');
  if n <> 2 then raise exception 'FAIL: platform-admin context does not see both tenants'' documents (saw %)', n; end if;
  raise notice 'PASS: platform-admin context sees across tenants';
end
$$;
select set_config('app.is_platform_admin', 'false', false);

-- Test 8 — system_context bypass, same shape, for the webhook/cron path.
select set_config('app.system_context', 'true', false);
do $$
declare n int;
begin
  select count(*) into n from public.documents
    where document_id in ('99990000-0000-0000-0000-0000000000a1', '99990000-0000-0000-0000-0000000000b1');
  if n <> 2 then raise exception 'FAIL: system_context does not see across tenants (saw %)', n; end if;
  raise notice 'PASS: system_context sees across tenants';
end
$$;
select set_config('app.system_context', 'false', false);

-- Test 9 — with both bypasses off again and no tenant set, back to
-- fail-closed: proves the bypasses don't leak past being turned off.
do $$
declare n int;
begin
  select count(*) into n from public.documents
    where document_id in ('99990000-0000-0000-0000-0000000000a1', '99990000-0000-0000-0000-0000000000b1');
  if n <> 0 then raise exception 'FAIL: visibility leaked after clearing both privilege flags (saw %)', n; end if;
  raise notice 'PASS: clearing privilege flags returns to fail-closed';
end
$$;

-- Test 10 — app_user itself must not be superuser/BYPASSRLS. If someone
-- "fixes" a permissions problem later by granting either, every test
-- above would start silently passing for the wrong reason.
do $$
declare is_super bool; bypasses bool;
begin
  select rolsuper, rolbypassrls into is_super, bypasses from pg_roles where rolname = 'app_user';
  if is_super then raise exception 'FAIL: app_user has been granted SUPERUSER — every policy above is now inert'; end if;
  if bypasses then raise exception 'FAIL: app_user has been granted BYPASSRLS — every policy above is now inert'; end if;
  raise notice 'PASS: app_user is neither superuser nor bypassrls';
end
$$;

reset role;
rollback;

\echo 'ALL RLS TESTS PASSED'
