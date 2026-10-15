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
