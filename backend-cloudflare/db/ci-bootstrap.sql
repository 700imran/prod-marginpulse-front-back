-- CI / local-test bootstrap: Supabase provides auth.users; plain Postgres does not.
-- Only the columns that public.* tables reference are stubbed.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
