# Backup & recovery runbook

**Nothing in this file has been configured or tested yet** — there's no
live Supabase project behind this codebase at the time it was written
(see STATUS.md). This is the procedure to follow once one exists, not a
record of something already done. Don't claim backups are in place until
you've actually completed the steps below and run the restore test.

## What you're protecting against, and what already helps

| Risk | What covers it |
|---|---|
| Accidental single-document deletion | `src/purge.ts`'s 30-day soft-delete grace period (STATUS.md's "Data retention & deletion" section) — restorable without touching a backup at all |
| Accidental whole-account deletion | Same system, 30-day grace period on `tenants.deletion_requested_at` |
| Database corruption / bad migration / bulk data-loss bug | **Only a real backup** — soft-delete doesn't help if the bug is in the DELETE statement's WHERE clause, not just the deletion decision |
| R2 object loss | R2 itself is built for 11 nines of durability — this covers hardware failure, not an application bug that deletes the wrong key. See "Object storage" below. |
| Total Supabase/Cloudflare regional outage | Out of scope for this runbook — that's a provider incident, not something a backup fixes |

The soft-delete system is real protection for the most common failure
mode (someone — or some bug — deletes something they shouldn't have) but
is **not** a substitute for an actual point-in-time-recoverable backup.

## Database (Supabase Postgres)

Supabase's own backup capability depends on your plan:

- **Free tier**: daily backups, retained 7 days, no point-in-time
  recovery. This is not sufficient for financial reconciliation data —
  plan to be on at least the tier that includes PITR before handling
  real customer data.
- **Pro tier and above**: Point-in-time recovery (PITR), typically to
  within a couple of minutes, with a retention window set by your plan
  (verify the current number in your own project's Settings > Database
  > Backups — Supabase's exact PITR window varies by plan and changes
  over time, so don't hardcode a number here that could go stale).

**Action items** (do these once a real project exists, then check them
off and date it):

- [ ] Confirm your Supabase project's plan includes PITR, not just daily
      snapshots.
- [ ] In Settings > Database > Backups, note the actual retention window
      your plan gives you — this number is your real RPO ceiling, below.
- [ ] Set a calendar reminder to re-verify this after any plan change.

## Object storage (R2)

R2 objects (the actual uploaded documents) are **not** covered by
Supabase's Postgres backups — they live in a completely separate system.
R2 itself doesn't currently offer Cloudflare-managed point-in-time
backups the way Supabase's Postgres does. Two layers of protection
instead:

1. The `documents` row (in Postgres, so it **is** covered by Supabase's
   backup) records the `storage_key`, `mime_type`, and every extracted
   field for each document. If the R2 object itself were lost but the
   row survives (e.g., restored from a Postgres backup after an R2
   object was separately corrupted), the extracted data isn't lost —
   only the original file image is, for documents that were never
   re-OCR'd.
2. For genuine defense against R2-side data loss, evaluate R2's [bucket
   versioning](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
   or cross-bucket replication once this matters for your compliance
   requirements — not configured in this pass.

- [ ] Decide whether R2 versioning/replication is needed for your
      regulatory requirements (GST-related documents may have a
      statutory retention period under Indian tax law — confirm with
      whoever handles your compliance, this isn't legal advice) and
      configure it if so.

## RPO / RTO

Fill these in once you've confirmed your actual Supabase plan's PITR
window and done a real restore test — don't commit placeholder numbers
as if they were verified:

- **RPO (Recovery Point Objective)** — how much data you could lose:
  target ≤ your Supabase plan's PITR granularity (typically a few
  minutes on Pro+). Not yet verified against a real project.
- **RTO (Recovery Time Objective)** — how long a restore takes: depends
  on database size and hasn't been measured. Budget for Supabase support
  involvement on a PITR restore of a production database — this isn't
  usually instant or fully self-service.

## Restore-testing procedure

Do this at least once before handling real customer data, and periodically
after (quarterly is a reasonable starting cadence):

1. In a **separate, non-production Supabase project**, use Supabase's
   PITR restore feature to restore to a point in time from your actual
   production project's backup history (Supabase supports restoring to
   a new project without touching the original).
2. Point a throwaway copy of this Worker (separate Hyperdrive config,
   separate `wrangler.toml` environment) at the restored database.
3. Confirm: `db/rls_test.sql` still passes against it (proves the
   restore didn't silently drop the `app_user` role or any policy), a
   known document's data matches what you expect, and `GET /healthz`
   reports the database as healthy.
4. Record how long the restore actually took — that's your real,
   measured RTO, not a guess.
5. Delete the throwaway project when done.

## Incident: "we need to restore right now"

1. Don't restore the production project in place if avoidable — restore
   to a **new** project first (step 1 above) so you can verify before
   cutting over, and so production stays reachable (even if serving bad
   data) while you work.
2. Once verified, point production's Hyperdrive connection string at the
   restored database (or restore in place if Supabase's tooling and your
   verified runbook say that's safe for your situation).
3. Re-run `db/rls_test.sql` against the now-live database before
   resuming traffic.
4. Write up what happened — see the incident-response framework
   (tracked separately; not yet built as of this file's writing).
