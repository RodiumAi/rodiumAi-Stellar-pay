import { sql } from 'kysely';
import type { Executor } from './connection.js';

export interface ServiceCounts {
  readonly paymentsCreated: number;
  readonly paymentsConfirmed: number;
  readonly outboxPending: number;
  readonly outboxDead: number;
  readonly receiptsUnmatched: number;
}

/**
 * Database-wide counts for the §18 metrics. Rows are never deleted, so the payment counts
 * only grow and can be exported as counters; every worker reports the same values
 * (aggregate with `max` across replicas). All filters hit partial or primary indexes.
 */
export async function serviceCounts(db: Executor): Promise<ServiceCounts> {
  const { rows } = await sql<{
    created: number;
    confirmed: number;
    pending: number;
    dead: number;
    unmatched: number;
  }>`
    SELECT
      (SELECT count(*) FROM payments)::int AS created,
      (SELECT count(*) FROM payments WHERE status = 'confirmed')::int AS confirmed,
      (SELECT count(*) FROM outbox_events WHERE status = 'pending')::int AS pending,
      (SELECT count(*) FROM outbox_events WHERE status = 'dead')::int AS dead,
      (SELECT count(*) FROM chain_receipts WHERE match = 'unmatched')::int AS unmatched
  `.execute(db);
  const r = rows[0];
  if (r === undefined) throw new Error('serviceCounts: no row');
  return {
    paymentsCreated: r.created,
    paymentsConfirmed: r.confirmed,
    outboxPending: r.pending,
    outboxDead: r.dead,
    receiptsUnmatched: r.unmatched,
  };
}
