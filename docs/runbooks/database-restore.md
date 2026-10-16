# Database restore

Two paths: **A.** Supabase point-in-time recovery (PITR) on the production project; **B.** the
weekly `age`-encrypted `pg_dump` of the `pay` schema, for when the Supabase account itself is gone
(§7.6). Also used for the monthly restore drill into a scratch project.

## When to use

- Data deleted or corrupted (bad migration, manual mistake, compromised role).
- Supabase project or organization unavailable or lost (path B).
- The monthly drill (path A or B into a scratch project; fill in the record at the bottom).

## Signals

- `/v1/health/ready` failing on Supabase; API 5xx; worker `job pass failed` on every job.
- Missing or wrong rows reported by the main app.

## Before you start

- Supabase owner access with MFA; for path B, the `age` identity (held outside Supabase and AWS)
  and read access to the separate backup bucket.
- A second person to choose the restore point and sign off the checks.
- Run [kill-switch.md](kill-switch.md) step 1 (main app flag off) so nobody pays during the restore.

## Steps — A. Supabase PITR

1. Pick the restore time `T` (just before the damage) and write it in the incident ticket.
2. Stop writers: `kubectl -n rodium-pay scale deployment/rp-worker deployment/rp-api --replicas=0`.
3. Supabase dashboard → project → Database → Backups → Point in time → `T` → confirm. A drill
   restores into a scratch project instead (restore-to-new-project, where the plan offers it).
4. Roles and passwords come back as they were at `T`. If they were rotated after `T`, re-set them
   (see "Supabase role passwords" in [rotation.md](rotation.md)).
5. Run the checks below, then scale up: worker first (`--replicas=1`, then 2), then the API.

## Steps — B. Encrypted logical export

The weekly export is made by the `rp-backup` CronJob (`scripts/backup/export.sh`, image
`infra/docker/Dockerfile.backup`): `pg_dump --schema=pay --format=custom --no-owner --no-privileges`
streamed through `age`, so the plaintext never touches disk. `scripts/backup/restore.sh` does the
reverse (`age -d | pg_restore`). Because the dump carries no owners or grants, re-run
`packages/db/migrations/0002_grants.sql` and `0004` grants as `rp_owner` after restoring, and
`ALTER SCHEMA pay OWNER TO rp_owner` (plus its objects) if the restore ran as `postgres`.
`scripts/backup/drill-local.sh` runs the whole loop against the local dev database. The steps
below are the manual equivalent for a real recovery.

1. Create a new Postgres 17 database (new Supabase project in another account, or any managed PG 17).
2. Bootstrap roles as `postgres` with fresh 32+ character passwords (`infra/supabase/bootstrap-roles.sql`;
   set `rp.owner_pw`, `rp.api_pw`, `rp.worker_pw`, `rp.readonly_pw` with `set_config` first).
3. Fetch and decrypt the newest export:
   ```sh
   age --decrypt -i rp-backup-identity.txt -o pay.dump pay-<date>.dump.age
   pg_restore --list pay.dump | head      # custom format, schema pay
   ```
4. Restore as `postgres` (owners and grants in the dump refer to the roles from step 2):
   `pg_restore --dbname "<target url>" --schema=pay --clean --if-exists --exit-on-error pay.dump`.
5. Apply any newer migrations as `rp_owner` (`pay.schema_migrations` shows what the dump has).
6. Update `DATABASE_URL_API` and `DATABASE_URL_WORKER` in Secrets
   Manager (`rodium-pay/api/…`, `rodium-pay/worker/…`), allow the new host in the egress network
   policy, restart, then run the checks.

## Checks (both paths)

```sql
SELECT max(created_at) FROM pay.payments;          -- close to T (A) or the export time (B)
SELECT source, ledger, updated_at FROM pay.ingest_cursors;
SELECT status, count(*) FROM pay.outbox_events GROUP BY status;
SELECT version FROM pay.schema_migrations ORDER BY version DESC LIMIT 1;
SELECT count(*) FROM pay.chain_receipts WHERE match = 'unmatched';
```

## What the restore loses, and how it heals

- Ingest restarts from the restored cursor and re-reads payments from Horizon (idempotent). Their
  webhooks are sent again **with new event ids**; warn the main app to dedupe on `payment_id` too.
- Payments created after `T` are gone; customers who paid them show up as `unknown_memo` unmatched
  receipts → [unmatched-payment.md](unmatched-payment.md). Ask the main app for orders after `T`.
- Contract events resume from `contract:<CONTRACT_ID>`; if that ledger is older than RPC retention
  (testnet ~3 h), compare active subscriptions with `stellar contract invoke ... -- get --sub_id <n>`.

## Afterwards

- `audit_log` row `action = 'db.restore'` with `T`, path, approver. Postmortem for any real restore.

## Restore drill record

Copy one block per drill (monthly) below this line.

```text
Date:            YYYY-MM-DD
Who:             <operator> / <second person>
Path:            A (PITR) | B (age export)
Source:          <prod project ref> @ <restore point or export file>
Target project:  <scratch project ref>
Duration:        <start → service-ready, minutes>
Checks done:     row counts vs source, max(created_at), ingest_cursors, schema_migrations,
                 worker started against target and ingested, sample payment decrypts via API
Result:          pass | fail — <notes, follow-up issues>
```

```text
Date:            2026-10-16
Who:             local drill (Sprint 10) — not yet a Supabase scratch-project drill
Path:            B (age export) via scripts/backup/drill-local.sh
Source:          local dev database rodium_pay_dev (Postgres 17.6)
Target project:  scratch database rodium_pay_drill on the same local server
Duration:        5 s export + restore (33,954 bytes encrypted)
Checks done:     export is not plaintext; row counts per table identical (8 tables incl.
                 schema_migrations)
Result:          pass — first real drill into a scratch Supabase project still to do
                 (needs Supabase access)
```
