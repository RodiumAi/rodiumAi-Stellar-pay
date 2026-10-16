import { sql } from 'kysely';
import type { Executor, Tx } from './connection.js';
import type { OutboxRow } from './schema.js';

export interface OutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

/** Must run in the same transaction as the state change it announces (context §10.1). */
export async function enqueueEvent(tx: Tx, event: OutboxEvent): Promise<void> {
  await tx
    .insertInto('outbox_events')
    .values({
      id: event.id,
      event_type: event.type,
      aggregate_id: event.aggregateId,
      payload: JSON.stringify(event.payload),
    })
    .execute();
}

export async function claimDueEvents(tx: Tx, now: Date, limit: number): Promise<OutboxRow[]> {
  return tx
    .selectFrom('outbox_events')
    .selectAll()
    .where('status', '=', 'pending')
    .where('next_attempt_at', '<=', now)
    .orderBy('next_attempt_at')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
}

export async function markDelivered(db: Executor, id: string, at: Date): Promise<void> {
  await db
    .updateTable('outbox_events')
    .set({ status: 'delivered', delivered_at: at })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .execute();
}

export async function markAttemptFailed(
  db: Executor,
  id: string,
  failure: { readonly error: string; readonly nextAttemptAt: Date | null },
): Promise<void> {
  await db
    .updateTable('outbox_events')
    .set((eb) => ({
      attempts: eb('attempts', '+', 1),
      last_error: failure.error.slice(0, 500),
      ...(failure.nextAttemptAt === null
        ? { status: 'dead' as const }
        : { next_attempt_at: failure.nextAttemptAt }),
    }))
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .execute();
}

/**
 * Claims due events by pushing `next_attempt_at` forward by a lease, in one short
 * statement. Delivery then happens outside any transaction (a slow receiver must not
 * hold row locks); if the worker dies, the event becomes due again when the lease ends.
 */
export async function leaseDueEvents(
  db: Executor,
  now: Date,
  limit: number,
  leaseSeconds: number,
): Promise<OutboxRow[]> {
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
  return db
    .updateTable('outbox_events')
    .set({ next_attempt_at: leaseUntil })
    .where(
      'id',
      'in',
      db
        .selectFrom('outbox_events')
        .select('id')
        .where('status', '=', 'pending')
        .where('next_attempt_at', '<=', now)
        .orderBy('next_attempt_at')
        .limit(limit)
        .forUpdate()
        .skipLocked(),
    )
    .returningAll()
    .execute();
}

/** Admin replay of a `dead` event: back to pending, due now, attempts reset. */
export async function requeueDeadEvent(db: Executor, id: string, now: Date): Promise<boolean> {
  const row = await db
    .updateTable('outbox_events')
    .set({ status: 'pending', attempts: 0, next_attempt_at: now, last_error: null })
    .where('id', '=', id)
    .where('status', '=', 'dead')
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function countDeadEvents(db: Executor): Promise<number> {
  const row = await db
    .selectFrom('outbox_events')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('status', '=', 'dead')
    .executeTakeFirstOrThrow();
  return row.n;
}
