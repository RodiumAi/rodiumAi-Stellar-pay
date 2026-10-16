import { cryptoRandomBytes } from '@rp/core/random';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import type { Db, Tx } from '@rp/db/connection';
import { getCursor, saveCursor } from '@rp/db/cursors';
import { enqueueEvent } from '@rp/db/outbox';
import {
  activateSubscription,
  findSubscriptionByActivationTx,
  findSubscriptionByContractId,
  transitionSubscription,
} from '@rp/db/subscriptions';
import type { SubscriptionRow } from '@rp/db/schema';
import { parseSubscriptionEvent, type ParsedEvent } from '@rp/stellar/contract-events';
import type { rpc } from '@stellar/stellar-sdk';
import type { Metrics } from '../metrics.js';
import type { Job, JobLogger } from '../scheduler.js';

export interface ContractEventsClient {
  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  getLatestLedger(): Promise<{ readonly sequence: number }>;
}

const newId = (): string => uuidV7(instant(Date.now()), cryptoRandomBytes);
const toDate = (unixSeconds: bigint): Date => new Date(Number(unixSeconds) * 1000);

/**
 * Checkout submit timed out before the subscribe transaction landed: the API recorded the
 * transaction hash; activate from the `sub_created` event of that transaction. The signed
 * subscriber and the plan must match what checkout recorded.
 */
async function activateFromEvent(
  tx: Tx,
  e: ParsedEvent,
  logger: JobLogger,
): Promise<SubscriptionRow | undefined> {
  if (e.event.type !== 'sub_created') return undefined;
  const pending = await findSubscriptionByActivationTx(tx, Buffer.from(e.txHash, 'hex'));
  if (pending?.status !== 'incomplete') return undefined;
  if (
    pending.subscriber_address !== e.event.subscriber ||
    pending.contract_plan_id !== e.event.planId
  ) {
    logger.warn(
      { alert: 'activation_mismatch', subscription_id: pending.id },
      'sub_created does not match the recorded checkout submission',
    );
    return undefined;
  }
  const activated = await activateSubscription(tx, pending.id, {
    subscriberAddress: e.event.subscriber,
    contractSubscriptionId: e.event.subId,
    allowanceExpiresLedger: pending.allowance_expires_ledger ?? 0,
  });
  if (activated === undefined) return undefined;
  await enqueueEvent(tx, {
    id: newId(),
    type: 'subscription.activated',
    aggregateId: activated.id,
    payload: {
      subscription_id: activated.id,
      merchant_subscription_ref: activated.merchant_subscription_ref,
      plan_code: activated.plan_code,
      contract_subscription_id: e.event.subId.toString(),
      tx_hash: e.txHash,
    },
  });
  logger.info({ subscription_id: activated.id }, 'subscription activated from contract event');
  return activated;
}

/** Keeps subscription state in sync with the chain, incl. cancellations from wallets (§13.4). */
async function apply(tx: Tx, e: ParsedEvent, logger: JobLogger): Promise<void> {
  const sub =
    (await findSubscriptionByContractId(tx, e.event.subId)) ??
    (await activateFromEvent(tx, e, logger));
  if (sub === undefined) {
    logger.warn(
      {
        alert: 'unmatched_subscription_event',
        type: e.event.type,
        sub_id: e.event.subId.toString(),
      },
      'contract event for unknown subscription',
    );
    return;
  }
  switch (e.event.type) {
    case 'sub_created': {
      if (sub.next_charge_at !== null) return;
      await transitionSubscription(tx, sub.id, sub.status, {
        status: sub.status,
        next_charge_at: toDate(e.event.nextChargeAt),
        current_period_end: toDate(e.event.nextChargeAt),
      });
      if (e.event.price !== sub.price_stroops) {
        logger.warn(
          { alert: 'plan_price_mismatch', subscription_id: sub.id },
          'on-chain price differs from configured plan',
        );
      }
      return;
    }
    case 'charged': {
      if (sub.status === 'canceled') return;
      const updated = await transitionSubscription(tx, sub.id, sub.status, {
        status: 'active',
        next_charge_at: toDate(e.event.nextChargeAt),
        current_period_end: toDate(e.event.nextChargeAt),
        failed_attempts: 0,
      });
      if (updated === undefined) return;
      await enqueueEvent(tx, {
        id: newId(),
        type: 'subscription.renewed',
        aggregateId: sub.id,
        payload: {
          subscription_id: sub.id,
          merchant_subscription_ref: sub.merchant_subscription_ref,
          amount: e.event.amount.toString(),
          next_charge_at: toDate(e.event.nextChargeAt).toISOString(),
          tx_hash: e.txHash,
        },
      });
      return;
    }
    case 'canceled': {
      if (sub.status === 'canceled') return;
      const updated = await transitionSubscription(tx, sub.id, sub.status, {
        status: 'canceled',
        canceled_at: e.ledgerClosedAt,
        next_charge_at: null,
      });
      if (updated === undefined) return;
      await enqueueEvent(tx, {
        id: newId(),
        type: 'subscription.canceled',
        aggregateId: sub.id,
        payload: {
          subscription_id: sub.id,
          merchant_subscription_ref: sub.merchant_subscription_ref,
          canceled_by: e.event.by === sub.subscriber_address ? 'subscriber' : 'admin',
          tx_hash: e.txHash,
        },
      });
      return;
    }
  }
}

export function createContractEventsJob(
  deps: {
    readonly db: Db;
    readonly client: ContractEventsClient;
    readonly contractId: string;
    readonly startLedger: number | null;
    readonly metrics: Metrics;
    readonly logger: JobLogger;
  },
  intervalMs = 5_000,
): Job {
  const cursorName = `contract:${deps.contractId}`;
  return {
    name: 'contract-events',
    intervalMs,
    async run(signal) {
      for (let i = 0; i < 20 && !signal.aborted; i++) {
        const saved = await getCursor(deps.db, cursorName);
        const position = saved
          ? { cursor: saved.cursor }
          : { startLedger: deps.startLedger ?? (await deps.client.getLatestLedger()).sequence };
        const res = await deps.client.getEvents({
          ...position,
          filters: [{ type: 'contract', contractIds: [deps.contractId] }],
          limit: 100,
        });
        await deps.db.transaction().execute(async (tx) => {
          for (const raw of res.events) {
            const parsed = parseSubscriptionEvent(raw, deps.contractId);
            if (parsed !== null) await apply(tx, parsed, deps.logger);
          }
          await saveCursor(tx, cursorName, {
            cursor: res.cursor,
            ledger: res.events.at(-1)?.ledger ?? saved?.ledger ?? res.latestLedger,
          });
        });
        deps.metrics.inc('contract_events_total', res.events.length);
        if (res.events.length < 100) return;
      }
    },
  };
}
