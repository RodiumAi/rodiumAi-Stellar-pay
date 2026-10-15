import type pg from 'pg';

/** Fixed key for the single ledger ingester (context §7.2). */
export const INGESTER_LOCK_KEY = 0x5250_494e_4745_5354n;

export interface LeaderLock {
  release(): Promise<void>;
}

/**
 * Tries to become leader. Advisory locks are session-scoped, so `client` must be a
 * dedicated session connection (Supavisor session mode or direct), held for the
 * whole leadership term — never a transaction-mode pooled connection.
 */
export async function tryAcquireLeaderLock(
  client: pg.ClientBase,
  key: bigint = INGESTER_LOCK_KEY,
): Promise<LeaderLock | null> {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [key.toString()],
  );
  if (rows[0]?.locked !== true) {
    return null;
  }
  return {
    release: async () => {
      await client.query('SELECT pg_advisory_unlock($1)', [key.toString()]);
    },
  };
}
