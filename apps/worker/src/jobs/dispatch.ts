import type { RandomBytes } from '@rp/core/random';
import type { Db } from '@rp/db/connection';
import { countDeadEvents, leaseDueEvents, markAttemptFailed, markDelivered } from '@rp/db/outbox';
import { nextAttemptAt } from '../backoff.js';
import type { Metrics } from '../metrics.js';
import type { Job, JobLogger } from '../scheduler.js';
import { deliverWebhook, WEBHOOK_TIMEOUT_MS, type WebhookSigner } from '../webhook.js';

export interface DispatchDeps {
  readonly db: Db;
  readonly url: string;
  readonly signer: WebhookSigner;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly randomBytes: RandomBytes;
  readonly metrics: Metrics;
  readonly logger: JobLogger;
  readonly batchSize?: number;
}

/** Context §10.1 / §15: every 5 s, deliver due outbox events at least once. */
export function createDispatchJob(deps: DispatchDeps, intervalMs = 5_000): Job {
  // The lease outlives one delivery's timeout, so a live worker never loses its claim.
  const leaseSeconds = Math.ceil((WEBHOOK_TIMEOUT_MS * 3) / 1000);
  return {
    name: 'dispatch-webhooks',
    intervalMs,
    async run(signal) {
      const events = await leaseDueEvents(deps.db, deps.now(), deps.batchSize ?? 20, leaseSeconds);
      for (const event of events) {
        if (signal.aborted) break;
        const result = await deliverWebhook(
          deps.url,
          event,
          deps.signer,
          Math.floor(deps.now().getTime() / 1000),
          deps.fetch,
        );
        if (result.ok) {
          await markDelivered(deps.db, event.id, deps.now());
          deps.metrics.inc('webhooks_delivered_total');
          continue;
        }
        const next = nextAttemptAt(event.attempts + 1, deps.now(), deps.randomBytes);
        await markAttemptFailed(deps.db, event.id, { error: result.error, nextAttemptAt: next });
        deps.metrics.inc('webhooks_failed_total');
        if (next === null) {
          deps.logger.warn(
            { alert: 'webhook_dead', event_id: event.id, type: event.event_type },
            'webhook dead after final attempt',
          );
        }
      }
      if (events.length > 0) deps.metrics.set('webhooks_dead', await countDeadEvents(deps.db));
    },
  };
}
