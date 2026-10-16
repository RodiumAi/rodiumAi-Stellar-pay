import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';

async function check(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await Promise.race([
      probe(),
      new Promise<boolean>((r) => {
        setTimeout(() => {
          r(false);
        }, 2000);
      }),
    ]);
  } catch {
    return false;
  }
}

/**
 * `/health/live`: the process is up. `/v1/health/ready`: Supabase, Upstash and the ledger
 * source are reachable (§18). The main app hides crypto checkout while ready fails (§10.4).
 * Unauthenticated, and reports only booleans.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/health/live', (_req, reply) => reply.send({ status: 'ok' }));

  app.get('/v1/health/ready', async (_req, reply) => {
    const [database, redis, ledger] = await Promise.all([
      check(deps.health.database),
      check(deps.health.redis),
      check(deps.health.ledger),
    ]);
    const ready = database && redis && ledger;
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'unavailable', checks: { database, redis, ledger } });
  });
}
