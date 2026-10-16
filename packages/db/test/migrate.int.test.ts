import { cp, mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { migrate } from '../src/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

async function withOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  it('re-running is a no-op', async () => {
    const result = await withOwner((c) => migrate(c, migrationsDir));
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      '0001_schema.sql',
      '0002_grants.sql',
      '0003_cancel_incomplete_subscriptions.sql',
    ]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-migrations-'));
    await cp(migrationsDir, dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
    await appendFile(join(dir, '0001_schema.sql'), '\n-- edited\n');
    await expect(withOwner((c) => migrate(c, dir))).rejects.toThrow('0001_schema.sql was modified');
  });

  it('creates every table with RLS enabled', async () => {
    const { rows } = await withOwner((c) =>
      c.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class
         WHERE relnamespace = 'pay'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'
         ORDER BY relname`,
      ),
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'audit_log',
      'chain_receipts',
      'ingest_cursors',
      'outbox_events',
      'payments',
      'subscription_charges',
      'subscriptions',
    ]);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('gives no service role BYPASSRLS or superuser', async () => {
    const { rows } = await withOwner((c) =>
      c.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('rp_owner', 'rp_api', 'rp_worker', 'rp_readonly') ORDER BY rolname`,
      ),
    );
    expect(rows.map((r) => r.rolname)).toEqual(['rp_api', 'rp_owner', 'rp_readonly', 'rp_worker']);
    expect(rows.some((r) => r.rolbypassrls || r.rolsuper)).toBe(false);
  });
});
