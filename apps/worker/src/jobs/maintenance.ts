import type { RandomBytes } from '@rp/core/random';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import type { Db } from '@rp/db/connection';
import { enqueueEvent } from '@rp/db/outbox';
import { prepareExtendTtl, submitAndWait, type SorobanClient } from '@rp/stellar/soroban';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Metrics } from '../metrics.js';
import type { Job, JobLogger } from '../scheduler.js';
import type { SignerClient } from '../signer-client.js';

/** ~5 s ledgers: 14 days of warning before the on-chain allowance lapses (§6). */
const WARN_LEDGERS = 14 * 17_280;

/** Hourly: emit `subscription.allowance_expiring` once per allowance (§15). */
export function createAllowanceWarningJob(
  deps: {
    readonly db: Db;
    readonly latestLedger: () => Promise<number>;
    readonly now: () => Date;
    readonly randomBytes: RandomBytes;
  },
  intervalMs = 3_600_000,
): Job {
  return {
    name: 'allowance-warnings',
    intervalMs,
    async run() {
      const latest = await deps.latestLedger();
      await deps.db.transaction().execute(async (tx) => {
        const due = await tx
          .selectFrom('subscriptions')
          .select(['id', 'merchant_subscription_ref', 'allowance_expires_ledger'])
          .where('status', 'in', ['active', 'past_due'])
          .where('allowance_expires_ledger', 'is not', null)
          .where('allowance_expires_ledger', '<=', latest + WARN_LEDGERS)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('outbox_events as o')
                  .select('o.id')
                  .whereRef('o.aggregate_id', '=', 'subscriptions.id')
                  .where('o.event_type', '=', 'subscription.allowance_expiring')
                  .where(
                    sql<boolean>`(o.payload->>'allowance_expires_ledger')::int = subscriptions.allowance_expires_ledger`,
                  ),
              ),
            ),
          )
          .execute();
        for (const s of due) {
          await enqueueEvent(tx, {
            id: uuidV7(instant(deps.now().getTime()), deps.randomBytes),
            type: 'subscription.allowance_expiring',
            aggregateId: s.id,
            payload: {
              subscription_id: s.id,
              merchant_subscription_ref: s.merchant_subscription_ref,
              allowance_expires_ledger: s.allowance_expires_ledger,
              ledgers_left: (s.allowance_expires_ledger ?? latest) - latest,
            },
          });
        }
      });
    },
  };
}

/** Daily: extend TTLs of active subscriptions' storage before archival (§14.4). */
export function createTtlExtensionJob(
  deps: {
    readonly db: Db;
    readonly chain: SorobanClient;
    readonly signer: SignerClient;
    readonly keeper: string;
    readonly contractId: string;
    readonly networkPassphrase: string;
    readonly extendToLedgers: number;
    readonly logger: JobLogger;
  },
  intervalMs = 86_400_000,
): Job {
  return {
    name: 'extend-ttls',
    intervalMs,
    async run(signal) {
      const rows = await deps.db
        .selectFrom('subscriptions')
        .select('contract_subscription_id')
        .where('status', 'in', ['active', 'past_due'])
        .where('contract_subscription_id', 'is not', null)
        .execute();
      const ids = rows.flatMap((r) =>
        r.contract_subscription_id === null ? [] : [r.contract_subscription_id],
      );
      for (let i = 0; i < ids.length && !signal.aborted; i += 20) {
        const prepared = await prepareExtendTtl(deps.chain, {
          contractId: deps.contractId,
          keeper: deps.keeper,
          subIds: ids.slice(i, i + 20),
          extendToLedgers: deps.extendToLedgers,
          networkPassphrase: deps.networkPassphrase,
          baseFee: '1000',
          timeoutSeconds: 120,
        });
        if (!prepared.ok) {
          deps.logger.warn({ detail: prepared.error.detail }, 'TTL extension simulation failed');
          continue;
        }
        if (prepared.value === null) continue;
        const signed = await deps.signer.sign(prepared.value);
        if (!signed.ok) {
          deps.logger.warn(
            { alert: 'signer_rejection', reason: signed.error },
            'signer refused TTL extension',
          );
          continue;
        }
        await submitAndWait(deps.chain, signed.value, deps.networkPassphrase);
      }
    },
  };
}

/** Every 5 min: alert when the keeper cannot pay fees much longer (§15). */
export function createKeeperBalanceJob(
  deps: {
    readonly horizonUrl: string;
    readonly keeper: string;
    readonly minBalanceXlm: number;
    readonly fetch: typeof fetch;
    readonly metrics: Metrics;
    readonly logger: JobLogger;
  },
  intervalMs = 300_000,
): Job {
  const Account = z.object({
    balances: z.array(z.object({ asset_type: z.string(), balance: z.string() })),
  });
  return {
    name: 'keeper-balance',
    intervalMs,
    async run() {
      const res = await deps.fetch(
        `${deps.horizonUrl.replace(/\/+$/, '')}/accounts/${deps.keeper}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) {
        deps.logger.warn(
          { alert: 'keeper_balance_unknown', status: res.status },
          'keeper account not readable',
        );
        return;
      }
      const native = Account.parse(await res.json()).balances.find(
        (b) => b.asset_type === 'native',
      );
      // Monitoring only; never used for money decisions.
      const xlm = Number.parseFloat(native?.balance ?? '0');
      deps.metrics.set('keeper_balance_xlm', xlm);
      if (xlm < deps.minBalanceXlm) {
        deps.logger.warn(
          { alert: 'keeper_balance_low', balance_xlm: xlm, threshold: deps.minBalanceXlm },
          'keeper balance low',
        );
      }
    },
  };
}
