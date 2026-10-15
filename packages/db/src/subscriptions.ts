import type { Result } from '@rp/core/result';
import type { SubscriptionStatus } from '@rp/core/subscription';
import type { Updateable } from 'kysely';
import type { Executor, Tx } from './connection.js';
import { resolveIdempotentInsert, type IdempotentInsert } from './idempotency.js';
import type {
  ChargeRow,
  ChargeStatus,
  NewCharge,
  NewSubscription,
  SubscriptionRow,
  SubscriptionsTable,
} from './schema.js';

export async function insertSubscription(
  db: Executor,
  subscription: NewSubscription,
): Promise<Result<IdempotentInsert<SubscriptionRow>, 'idempotency_conflict'>> {
  const inserted = await db
    .insertInto('subscriptions')
    .values(subscription)
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returningAll()
    .executeTakeFirst();
  const existing =
    inserted ??
    (await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('idempotency_key', '=', subscription.idempotency_key)
      .executeTakeFirst());
  return resolveIdempotentInsert(inserted, existing, subscription.request_hash);
}

export async function findSubscriptionById(
  db: Executor,
  id: string,
): Promise<SubscriptionRow | undefined> {
  return db.selectFrom('subscriptions').selectAll().where('id', '=', id).executeTakeFirst();
}

/** Conditional update: zero rows means the status already moved on. */
export async function transitionSubscription(
  db: Executor,
  id: string,
  from: SubscriptionStatus,
  patch: Updateable<SubscriptionsTable> & { readonly status: SubscriptionStatus },
): Promise<SubscriptionRow | undefined> {
  return db
    .updateTable('subscriptions')
    .set(patch)
    .where('id', '=', id)
    .where('status', '=', from)
    .returningAll()
    .executeTakeFirst();
}

export async function claimDueSubscriptions(
  tx: Tx,
  now: Date,
  limit: number,
): Promise<SubscriptionRow[]> {
  return tx
    .selectFrom('subscriptions')
    .selectAll()
    .where('status', 'in', ['active', 'past_due'])
    .where('next_charge_at', '<=', now)
    .orderBy('next_charge_at')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
}

export async function insertCharge(db: Executor, charge: NewCharge): Promise<ChargeRow> {
  return db
    .insertInto('subscription_charges')
    .values(charge)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function transitionCharge(
  db: Executor,
  id: string,
  from: ChargeStatus,
  to: ChargeStatus,
  details: { readonly txHash?: Buffer; readonly failureCode?: string } = {},
): Promise<ChargeRow | undefined> {
  return db
    .updateTable('subscription_charges')
    .set({
      status: to,
      ...(details.txHash === undefined ? {} : { tx_hash: details.txHash }),
      ...(details.failureCode === undefined ? {} : { failure_code: details.failureCode }),
    })
    .where('id', '=', id)
    .where('status', '=', from)
    .returningAll()
    .executeTakeFirst();
}
