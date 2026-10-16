import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/** Arbitrary fixed key so two migration runs never interleave. */
const MIGRATION_LOCK_KEY = 0x5250_4d49_4752_4154n;
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface RolePasswords {
  readonly owner: string;
  readonly api: string;
  readonly worker: string;
  readonly readonly: string;
}

/** Runs infra/supabase/bootstrap-roles.sql as the Supabase `postgres` role (context §7.3). */
export async function bootstrapRoles(
  admin: pg.ClientBase,
  rolesSql: string,
  passwords: RolePasswords,
): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query(
      `SELECT set_config('rp.owner_pw', $1, true), set_config('rp.api_pw', $2, true),
              set_config('rp.worker_pw', $3, true), set_config('rp.readonly_pw', $4, true)`,
      [passwords.owner, passwords.api, passwords.worker, passwords.readonly],
    );
    await admin.query(rolesSql);
    await admin.query('COMMIT');
  } catch (e) {
    await admin.query('ROLLBACK');
    throw e;
  }
}

/**
 * Applies forward-only migrations as rp_owner, one transaction per file.
 * An applied file whose checksum changed aborts the run: migrations are never edited.
 *
 * Every step holds a transaction-scoped advisory lock and re-reads what is applied inside
 * that transaction, so two concurrent runs never apply a file twice — and it works through
 * Supavisor's transaction pooler, where a session lock could be taken and released on
 * different server connections.
 */
export async function migrate(owner: pg.ClientBase, dir: string): Promise<MigrationResult> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled migrations dir
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    await owner.query('BEGIN');
    try {
      await owner.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
      const result = await fn();
      await owner.query('COMMIT');
      return result;
    } catch (e) {
      await owner.query('ROLLBACK');
      throw e;
    }
  };
  await locked(() =>
    owner.query(`CREATE TABLE IF NOT EXISTS pay.schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- name matched FILE_PATTERN
    const sql = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const outcome = await locked(async () => {
      const { rows } = await owner.query<{ checksum: string }>(
        'SELECT checksum FROM pay.schema_migrations WHERE version = $1',
        [file],
      );
      const previous = rows[0]?.checksum;
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied`);
        }
        return 'skipped' as const;
      }
      await owner.query(sql);
      await owner.query('INSERT INTO pay.schema_migrations (version, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      return 'applied' as const;
    });
    (outcome === 'applied' ? applied : skipped).push(file);
  }
  return { applied, skipped };
}
