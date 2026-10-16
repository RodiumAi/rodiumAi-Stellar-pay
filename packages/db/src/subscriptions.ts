import type { Result } from '@rp/core/result';
import type { SubscriptionStatus } from '@rp/core/subscription';
import { sql, type Updateable } from 'kysely';
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

/**
 * Inserts the charge for (subscription, period, attempt) unless it exists, without
 * aborting the surrounding transaction (a caught unique violation would). Returns the
 * row either way and whether it was created now.
 */
export async function insertChargeOnce(
  db: Executor,
  charge: NewCharge,
): Promise<{ readonly row: ChargeRow; readonly created: boolean }> {
  const inserted = await db
    .insertInto('subscription_charges')
    .values(charge)
    .onConflict((oc) => oc.columns(['subscription_id', 'period_index', 'attempt']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted !== undefined) return { row: inserted, created: true };
  const existing = await db
    .selectFrom('subscription_charges')
    .selectAll()
    .where('subscription_id', '=', charge.subscription_id)
    .where('period_index', '=', charge.period_index)
    .where('attempt', '=', charge.attempt ?? 1)
    .executeTakeFirstOrThrow();
  return { row: existing, created: false };
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

export async function findSubscriptionByTokenHash(
  db: Executor,
  hash: Buffer,
): Promise<SubscriptionRow | undefined> {
  return db
    .selectFrom('subscriptions')
    .selectAll()
    .where('checkout_token_hash', '=', hash)
    .executeTakeFirst();
}

export async function findSubscriptionByContractId(
  db: Executor,
  contractSubscriptionId: bigint,
): Promise<SubscriptionRow | undefined> {
  return db
    .selectFrom('subscriptions')
    .selectAll()
    .where('contract_subscription_id', '=', contractSubscriptionId)
    .executeTakeFirst();
}

/** incomplete → active once the user's `subscribe` succeeded on-chain (API role). */
export async function activateSubscription(
  db: Executor,
  id: string,
  chain: {
    readonly subscriberAddress: string;
    readonly contractSubscriptionId: bigint;
    readonly allowanceExpiresLedger: number;
  },
): Promise<SubscriptionRow | undefined> {
  return db
    .updateTable('subscriptions')
    .set({
      status: 'active',
      subscriber_address: chain.subscriberAddress,
      contract_subscription_id: chain.contractSubscriptionId,
      allowance_expires_ledger: chain.allowanceExpiresLedger,
    })
    .where('id', '=', id)
    .where('status', '=', 'incomplete')
    .returningAll()
    .executeTakeFirst();
}

/** Number of successful charges so far; the next charge's `period_index`. */
export async function countSucceededCharges(db: Executor, subscriptionId: string): Promise<number> {
  const row = await db
    .selectFrom('subscription_charges')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('subscription_id', '=', subscriptionId)
    .where('status', '=', 'succeeded')
    .executeTakeFirstOrThrow();
  return row.n;
}
