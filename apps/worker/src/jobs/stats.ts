import type { Db } from '@rp/db/connection';
import { serviceCounts } from '@rp/db/stats';
import type { Metrics } from '../metrics.js';
import type { Job } from '../scheduler.js';

/** Context §18: database-wide counts and the mTLS certificate expiry, every 30 s. */
export function createStatsJob(
  deps: {
    readonly db: Db;
    readonly metrics: Metrics;
    /** Expiry (unix seconds) of the worker's mTLS client certificate, when configured. */
    readonly certNotAfter: (() => number) | null;
  },
  intervalMs = 30_000,
): Job {
  return {
    name: 'stats',
    intervalMs,
    async run() {
      const c = await serviceCounts(deps.db);
      deps.metrics.set('payments_created_total', c.paymentsCreated);
      deps.metrics.set('payments_confirmed_total', c.paymentsConfirmed);
      deps.metrics.set('outbox_pending', c.outboxPending);
      deps.metrics.set('webhooks_dead', c.outboxDead);
      deps.metrics.set('receipts_unmatched_open', c.receiptsUnmatched);
      if (deps.certNotAfter !== null) {
        deps.metrics.set('mtls_cert_not_after_timestamp_seconds', deps.certNotAfter());
      }
    },
  };
}
