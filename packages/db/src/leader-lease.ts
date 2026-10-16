import { sql } from 'kysely';
import type { Executor } from './connection.js';

/** The single ledger ingester (context §7.2). */
export const INGESTER_LEASE = 'ingest';

/**
 * Takes or renews the lease `name` for `holder` for `ttlSeconds`, if it is free, expired
 * or already ours — one atomic statement, safe through a transaction pooler. Returns
 * whether `holder` now holds it. Expiry uses the database clock.
 */
export async function tryAcquireLease(
  db: Executor,
  name: string,
  holder: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new RangeError('ttlSeconds');
  const { rows } = await sql<{ holder: string }>`
    INSERT INTO leader_leases AS l (name, holder, expires_at)
    VALUES (${name}, ${holder}, now() + make_interval(secs => ${ttlSeconds}))
    ON CONFLICT (name) DO UPDATE
      SET holder = EXCLUDED.holder,
          expires_at = EXCLUDED.expires_at,
          acquired_at = CASE WHEN l.holder = EXCLUDED.holder THEN l.acquired_at ELSE now() END
      WHERE l.holder = EXCLUDED.holder OR l.expires_at < now()
    RETURNING holder
  `.execute(db);
  return rows[0]?.holder === holder;
}

/** Gives the lease up early (graceful shutdown) so a standby takes over at once. */
export async function releaseLease(db: Executor, name: string, holder: string): Promise<void> {
  await db
    .deleteFrom('leader_leases')
    .where('name', '=', name)
    .where('holder', '=', holder)
    .execute();
}
