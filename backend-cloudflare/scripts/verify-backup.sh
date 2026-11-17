#!/usr/bin/env bash
# Backup you have never restored is a hope, not a backup. This script proves a dump of the live database can be restored and
# that the restored copy holds the same data.
#
#   SOURCE_DB_URL  direct Postgres connection string of the database to check (Supabase: Settings → Database → "Direct connection",
#                  NOT the pooler / Hyperdrive string — pg_dump needs a session connection). Read-only: only SELECTs and pg_dump.
#   RESTORE_ADMIN_URL  connection string of a SCRATCH Postgres server you control (a local Docker/Postgres is fine) with
#                  permission to CREATE DATABASE. It must be a different server from the source. A temporary database is created
#                  there, filled, compared and dropped.
#
# What it does: dump schema `public` → restore into a fresh scratch database (auth.users is stubbed with the same ids, as the
# restore target is not Supabase) → compare the row count of every table with the source → drop the scratch database.
# Exit code 0 = restore worked and counts agree; non-zero = something is wrong (the reason is printed).
#
# Needs pg_dump / pg_restore / psql, with pg_dump at least as new as the source server's major version.
# Counts are taken before and after the dump; a live database keeps changing, so a restored count passes when it lies between the two.
set -euo pipefail
: "${SOURCE_DB_URL:?set SOURCE_DB_URL (direct connection string of the database to verify)}"
: "${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL (scratch server with CREATE DATABASE permission)}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; name="mp_restore_check_$(date +%s)_$$"
# Build "<admin url with the scratch db name>" without printing credentials anywhere.
target_url="$(printf '%s' "$RESTORE_ADMIN_URL" | sed -E "s#(://[^/]+)/[^?]*#\1/${name}#")"
cleanup() { psql "$RESTORE_ADMIN_URL" -qAt -c "drop database if exists \"$name\" with (force)" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

counts() { # prints "table<TAB>rows" for every table in public
  psql "$1" -qAt -F $'\t' -c "select tablename from pg_tables where schemaname='public' order by 1" | while read -r t; do
    printf '%s\t%s\n' "$t" "$(psql "$1" -qAt -c "select count(*) from public.\"$t\"")"
  done
}

echo "1/5 counting source tables (before)"; counts "$SOURCE_DB_URL" > "$work/before.tsv"
echo "2/5 dumping schema public"; pg_dump "$SOURCE_DB_URL" --schema=public --format=custom --no-owner --no-privileges --file="$work/dump.pgc"
counts "$SOURCE_DB_URL" > "$work/after.tsv"
echo "3/5 creating scratch database and stubbing auth.users"
psql "$RESTORE_ADMIN_URL" -qAt -c "create database \"$name\"" >/dev/null
psql "$target_url" -q -v ON_ERROR_STOP=1 -f "$here/db/ci-bootstrap.sql" >/dev/null
psql "$SOURCE_DB_URL" -qAt -c "\\copy (select id, email from auth.users) to stdout" | psql "$target_url" -q -v ON_ERROR_STOP=1 -c "\\copy auth.users (id, email) from stdin"
echo "4/5 restoring"; psql "$target_url" -q -v ON_ERROR_STOP=1 -c "drop schema public cascade" # the dump re-creates schema public itself
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target_url" "$work/dump.pgc"
echo "5/5 comparing row counts"; counts "$target_url" > "$work/restored.tsv"
fail=0
printf '%-28s %12s %12s %12s  %s\n' table source_before restored source_after result
while IFS=$'\t' read -r t b; do
  a="$(awk -F'\t' -v t="$t" '$1==t{print $2}' "$work/after.tsv")"; r="$(awk -F'\t' -v t="$t" '$1==t{print $2}' "$work/restored.tsv")"
  lo=$(( b < a ? b : a )); hi=$(( b > a ? b : a ))
  if [ -n "$r" ] && [ "$r" -ge "$lo" ] && [ "$r" -le "$hi" ]; then res=ok; else res=MISMATCH; fail=1; fi
  printf '%-28s %12s %12s %12s  %s\n' "$t" "$b" "${r:-missing}" "$a" "$res"
done < "$work/before.tsv"
if [ "$fail" -eq 0 ]; then echo "RESTORE VERIFIED: every table restored with matching row counts."; else echo "RESTORE FAILED: see MISMATCH rows above." >&2; fi
exit "$fail"
