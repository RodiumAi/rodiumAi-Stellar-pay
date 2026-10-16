import type { RandomBytes } from '@rp/core/random';
import { transitionSubscription as nextState, DEFAULT_RETRY_POLICY } from '@rp/core/subscription';
import { duration, instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import type { Db } from '@rp/db/connection';
import { enqueueEvent } from '@rp/db/outbox';
import type { SubscriptionRow } from '@rp/db/schema';
import {
  claimDueSubscriptions,
  countSucceededCharges,
  insertChargeOnce,
  transitionCharge,
  transitionSubscription,
} from '@rp/db/subscriptions';
import {
  parseChargeOutcome,
  prepareCharge,
  readSubscription,
  submitAndWait,
  type SorobanClient,
} from '@rp/stellar/soroban';
import type { Metrics } from '../metrics.js';
import type { Job, JobLogger } from '../scheduler.js';
import type { SignerClient } from '../signer-client.js';

/** While a charge is in flight the row is pushed out of the due window (a lease). */
const CHARGE_LEASE_MS = 10 * 60_000;

interface Claimed {
  readonly sub: SubscriptionRow;
  readonly chargeId: string;
}

export interface ChargeDeps {
  readonly db: Db;
  readonly chain: SorobanClient;
  readonly signer: SignerClient;
  readonly keeper: string;
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly maxFeeStroops: bigint;
  readonly now: () => Date;
  readonly randomBytes: RandomBytes;
  readonly metrics: Metrics;
  readonly logger: JobLogger;
  readonly batchSize?: number;
}

/**
 * Context §15: claim due subscriptions, simulate `charge`, have the signer sign, submit,
 * record. A simulation or submit failure records a failed charge and applies the retry
 * schedule (past_due → canceled); nothing is submitted after a failed simulation.
 */
export function createChargeJob(deps: ChargeDeps, intervalMs = 60_000): Job {
  const newId = (): string => uuidV7(instant(deps.now().getTime()), deps.randomBytes);

  const claim = async (): Promise<Claimed[]> =>
    deps.db.transaction().execute(async (tx) => {
      const claimed: Claimed[] = [];
      for (const sub of await claimDueSubscriptions(tx, deps.now(), deps.batchSize ?? 10)) {
        if (sub.contract_subscription_id === null || sub.next_charge_at === null) continue;
        const charge = await insertChargeOnce(tx, {
          id: newId(),
          subscription_id: sub.id,
          period_index: (await countSucceededCharges(tx, sub.id)) + 1,
          amount_stroops: sub.price_stroops,
          attempt: sub.failed_attempts + 1,
        });
        // A leftover row from a crashed pass: retry it (the contract refuses a second charge
        // in the same period), unless it already succeeded — event sync fixes the schedule.
        if (charge.row.status === 'succeeded') continue;
        if (!charge.created && charge.row.status !== 'scheduled') {
          await transitionCharge(tx, charge.row.id, charge.row.status, 'scheduled');
        }
        const chargeId = charge.row.id;
        await transitionSubscription(tx, sub.id, sub.status, {
          status: sub.status,
          next_charge_at: new Date(deps.now().getTime() + CHARGE_LEASE_MS),
        });
        claimed.push({ sub, chargeId });
      }
      return claimed;
    });

  const fail = async ({ sub, chargeId }: Claimed, code: string): Promise<void> => {
    const now = deps.now();
    // Error codes are only unique per contract (the USDC SAC's balance error is also #10),
    // so ask the chain whether the charge was actually due before calling it a failure.
    const onChain = await readSubscription(deps.chain, {
      contractId: deps.contractId,
      source: deps.keeper,
      subId: sub.contract_subscription_id ?? 0n,
      networkPassphrase: deps.networkPassphrase,
    }).catch(() => null);
    if (onChain?.active === true && onChain.nextChargeAt * 1000n > BigInt(now.getTime())) {
      await deps.db.transaction().execute(async (tx) => {
        await transitionCharge(tx, chargeId, 'scheduled', 'failed', { failureCode: 'not_due' });
        await transitionSubscription(tx, sub.id, sub.status, {
          status: sub.status,
          next_charge_at: new Date(Number(onChain.nextChargeAt) * 1000),
        });
      });
      deps.logger.info({ subscription_id: sub.id }, 'charge not due on-chain; schedule resynced');
      return;
    }
    const state = nextState(
      {
        status: sub.status,
        interval: duration(sub.interval_seconds * 1000),
        currentPeriodEnd:
          sub.current_period_end === null ? null : instant(sub.current_period_end.getTime()),
        nextChargeAt: sub.next_charge_at === null ? null : instant(sub.next_charge_at.getTime()),
        failedAttempts: sub.failed_attempts,
        canceledAt: null,
      },
      {
        type: 'charge_failed',
        at: instant(Math.max(now.getTime(), sub.next_charge_at?.getTime() ?? 0)),
      },
      DEFAULT_RETRY_POLICY,
    );
    if (!state.ok) return;
    const next = state.value;
    await deps.db.transaction().execute(async (tx) => {
      await transitionCharge(tx, chargeId, 'scheduled', 'failed', {
        failureCode: code.slice(0, 120),
      });
      const updated = await transitionSubscription(tx, sub.id, sub.status, {
        status: next.status,
        failed_attempts: next.failedAttempts,
        next_charge_at: next.nextChargeAt === null ? null : new Date(next.nextChargeAt),
        ...(next.status === 'canceled' ? { canceled_at: now } : {}),
      });
      if (updated === undefined) return;
      await enqueueEvent(tx, {
        id: newId(),
        type: next.status === 'canceled' ? 'subscription.canceled' : 'subscription.past_due',
        aggregateId: sub.id,
        payload: {
          subscription_id: sub.id,
          merchant_subscription_ref: sub.merchant_subscription_ref,
          failed_attempts: next.failedAttempts,
          next_retry_at:
            next.nextChargeAt === null ? null : new Date(next.nextChargeAt).toISOString(),
          ...(next.status === 'canceled' ? { canceled_by: 'retries_exhausted' } : {}),
        },
      });
    });
    deps.metrics.inc('charges_failed_total');
    deps.logger.warn(
      { subscription_id: sub.id, code, status: next.status },
      'subscription charge failed',
    );
  };

  return {
    name: 'charge-subscriptions',
    intervalMs,
    async run(signal) {
      for (const claimed of await claim()) {
        if (signal.aborted) break;
        const { sub, chargeId } = claimed;
        const subId = sub.contract_subscription_id ?? 0n;
        const prepared = await prepareCharge(deps.chain, {
          contractId: deps.contractId,
          keeper: deps.keeper,
          subId,
          networkPassphrase: deps.networkPassphrase,
          baseFee: '1000',
          maxFeeStroops: deps.maxFeeStroops,
          timeoutSeconds: 120,
        });
        if (!prepared.ok) {
          await fail(claimed, `${prepared.error.code}: ${prepared.error.detail}`);
          continue;
        }
        const signed = await deps.signer.sign(prepared.value);
        if (!signed.ok) {
          deps.logger.warn(
            { alert: 'signer_rejection', subscription_id: sub.id, reason: signed.error },
            'signer refused charge',
          );
          await fail(claimed, `signer: ${signed.error}`);
          continue;
        }
        await transitionCharge(deps.db, chargeId, 'scheduled', 'submitted');
        const outcome = await submitAndWait(deps.chain, signed.value, deps.networkPassphrase);
        if (outcome.status !== 'success') {
          await transitionCharge(deps.db, chargeId, 'submitted', 'scheduled');
          await fail(
            claimed,
            outcome.status === 'failed' ? `submit: ${outcome.detail}` : 'submit: pending',
          );
          continue;
        }
        const result = parseChargeOutcome(outcome.returnValue);
        await deps.db.transaction().execute(async (tx) => {
          await transitionCharge(tx, chargeId, 'submitted', 'succeeded', {
            txHash: Buffer.from(outcome.hash, 'hex'),
          });
          if (result !== null) {
            await transitionSubscription(tx, sub.id, sub.status, {
              status: 'active',
              failed_attempts: 0,
              next_charge_at: new Date(Number(result.nextChargeAt) * 1000),
              current_period_end: new Date(Number(result.nextChargeAt) * 1000),
            });
          }
        });
        deps.metrics.inc('charges_succeeded_total');
      }
    },
  };
}
