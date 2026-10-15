import type { PaymentStatus } from '@rp/core/payment';
import type { Result } from '@rp/core/result';
import type { Executor, Tx } from './connection.js';
import { resolveIdempotentInsert, type IdempotentInsert } from './idempotency.js';
import type { NewPayment, PaymentRow } from './schema.js';

export async function insertPayment(
  db: Executor,
  payment: NewPayment,
): Promise<Result<IdempotentInsert<PaymentRow>, 'idempotency_conflict'>> {
  const inserted = await db
    .insertInto('payments')
    .values(payment)
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returningAll()
    .executeTakeFirst();
  const existing =
    inserted ??
    (await db
      .selectFrom('payments')
      .selectAll()
      .where('idempotency_key', '=', payment.idempotency_key)
      .executeTakeFirst());
  return resolveIdempotentInsert(inserted, existing, payment.request_hash);
}

export async function findPaymentById(db: Executor, id: string): Promise<PaymentRow | undefined> {
  return db.selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findPaymentByTokenHash(
  db: Executor,
  hash: Buffer,
): Promise<PaymentRow | undefined> {
  return db
    .selectFrom('payments')
    .selectAll()
    .where('checkout_token_hash', '=', hash)
    .executeTakeFirst();
}

/** Locks the payment row for the rest of the transaction so concurrent receipts serialize. */
export async function lockPaymentByMemo(tx: Tx, memo: string): Promise<PaymentRow | undefined> {
  return tx
    .selectFrom('payments')
    .selectAll()
    .where('memo', '=', memo)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Conditional transition (context §6): affects zero rows when the status moved on,
 * which callers treat as a no-op, never as an error to retry blindly.
 */
export async function transitionPaymentStatus(
  db: Executor,
  id: string,
  from: PaymentStatus,
  to: PaymentStatus,
): Promise<PaymentRow | undefined> {
  return db
    .updateTable('payments')
    .set({ status: to })
    .where('id', '=', id)
    .where('status', '=', from)
    .returningAll()
    .executeTakeFirst();
}

/** Adds to the received total in SQL (never read-modify-write in application code). */
export async function addReceivedAmount(
  tx: Tx,
  params: {
    readonly id: string;
    readonly expectedStatus: PaymentStatus;
    readonly amount: bigint;
    readonly newStatus: PaymentStatus;
    readonly at: Date;
  },
): Promise<PaymentRow | undefined> {
  return tx
    .updateTable('payments')
    .set((eb) => ({
      amount_received_stroops: eb('amount_received_stroops', '+', params.amount),
      status: params.newStatus,
      confirmed_at:
        params.newStatus === 'confirmed'
          ? eb.fn.coalesce('confirmed_at', eb.val(params.at))
          : eb.ref('confirmed_at'),
    }))
    .where('id', '=', params.id)
    .where('status', '=', params.expectedStatus)
    .returningAll()
    .executeTakeFirst();
}

/** Claims payments whose quote has expired, skipping rows another worker holds. */
export async function claimExpiringPayments(
  tx: Tx,
  now: Date,
  limit: number,
): Promise<PaymentRow[]> {
  return tx
    .selectFrom('payments')
    .selectAll()
    .where('status', 'in', ['pending', 'underpaid'])
    .where('expires_at', '<=', now)
    .orderBy('expires_at')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
}
