import type { RandomBytes } from '@rp/core/random';
import type { Stroops } from '@rp/core/money/stroops';
import { transitionPayment } from '@rp/core/payment';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import type { Db } from '@rp/db/connection';
import { enqueueEvent } from '@rp/db/outbox';
import { paymentEventData } from '@rp/db/payment-receipts';
import { claimExpiringPayments, transitionPaymentStatus } from '@rp/db/payments';
import type { Job } from '../scheduler.js';

/** Context §15: every 30 s, expire pending/underpaid payments past `expires_at`. */
export function createExpireJob(
  deps: { readonly db: Db; readonly now: () => Date; readonly randomBytes: RandomBytes },
  intervalMs = 30_000,
): Job {
  return {
    name: 'expire-payments',
    intervalMs,
    async run() {
      await deps.db.transaction().execute(async (tx) => {
        const now = deps.now();
        for (const p of await claimExpiringPayments(tx, now, 100)) {
          const t = transitionPayment(
            {
              status: p.status,
              amountDue: p.amount_due_stroops as Stroops,
              amountReceived: p.amount_received_stroops as Stroops,
              expiresAt: instant(p.expires_at.getTime()),
            },
            { type: 'expire', now: instant(now.getTime()) },
          );
          if (!t.ok) continue;
          const updated = await transitionPaymentStatus(tx, p.id, p.status, 'expired');
          if (updated === undefined) continue;
          await enqueueEvent(tx, {
            id: uuidV7(instant(now.getTime()), deps.randomBytes),
            type: 'payment.expired',
            aggregateId: updated.id,
            payload: await paymentEventData(tx, updated),
          });
        }
      });
    },
  };
}
