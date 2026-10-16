import { loadConfig } from '@rp/config/app-config';
import { cryptoRandomBytes } from '@rp/core/random';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import { appendAudit } from '@rp/db/audit-log';
import { createDb, createPool } from '@rp/db/connection';
import { requeueDeadEvent } from '@rp/db/outbox';
import { z } from 'zod';

/**
 * Admin CLI (context §10.1): replay a `dead` webhook event.
 *   node --env-file=.env apps/worker/dist/replay.js <event-id> <operator>
 */
async function main(): Promise<void> {
  const [rawId, rawOperator] = process.argv.slice(2);
  const parsed = z.tuple([z.uuid(), z.string().min(2).max(64)]).safeParse([rawId, rawOperator]);
  if (!parsed.success) {
    process.stderr.write('usage: replay.js <event-uuid> <operator-name>\n');
    process.exit(2);
  }
  const [eventId, operator] = parsed.data;
  const app = loadConfig(process.env);
  if (!app.ok) throw new Error(app.error.issues.join('; '));
  const pool = createPool({
    connectionString: process.env['DATABASE_URL_WORKER'] ?? '',
    max: 1,
    applicationName: 'rp-replay',
  });
  const db = createDb(pool);
  const now = new Date();
  const requeued = await db.transaction().execute(async (tx) => {
    const done = await requeueDeadEvent(tx, eventId, now);
    if (done) {
      await appendAudit(tx, {
        id: uuidV7(instant(now.getTime()), cryptoRandomBytes),
        actor: `admin:${operator}`,
        action: 'webhook.replay',
        targetId: eventId,
        details: {},
      });
    }
    return done;
  });
  await pool.end();
  process.stdout.write(
    requeued ? `requeued ${eventId}\n` : `not requeued: ${eventId} is not a dead event\n`,
  );
  process.exit(requeued ? 0 : 1);
}

void main();
