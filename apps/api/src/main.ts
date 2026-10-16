import { loadConfig } from '@rp/config/app-config';
import { cryptoRandomBytes } from '@rp/core/random';
import { createDb, createPool } from '@rp/db/connection';
import { loadKeyring } from '@rp/security/envelope';
import { createLocalDevKms, type Kms } from '@rp/security/kms';
import { createLogger } from '@rp/security/logger';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { sql } from 'kysely';
import { fileURLToPath } from 'node:url';
import { loadApiConfig } from './api-config.js';
import { loadCheckoutAssets } from './checkout/routes.js';
import { createExchangeRateApi } from './fx.js';
import { createUpstashKv } from './kv.js';
import { createInProcessLimiter, createUpstashLimiter } from './rate-limit.js';
import { buildServer } from './server.js';

/** Per API key per minute (context §8.2); the in-process backstop is deliberately lower. */
const RATE_LIMIT_PER_MINUTE = 120;
const BACKSTOP_PER_MINUTE = 30;
/** Graceful shutdown budget (context §15). */
const SHUTDOWN_GRACE_MS = 25_000;

function fail(lines: readonly string[]): never {
  process.stderr.write(`Invalid configuration:\n${lines.map((l) => `  - ${l}`).join('\n')}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const app = loadConfig(process.env);
  if (!app.ok) fail(app.error.issues);
  const api = loadApiConfig(process.env);
  if (!api.ok) fail(api.error);
  const logger = createLogger({ level: app.value.logLevel, service: 'api' });

  let kms: Kms;
  if (api.value.localDevKmsMasterKey !== null && app.value.env !== 'production') {
    kms = createLocalDevKms(api.value.localDevKmsMasterKey, cryptoRandomBytes);
  } else {
    // AWS KMS adapter arrives in Sprint 10; refuse to start rather than run without one.
    fail(['No KMS configured: LOCAL_DEV_KMS_MASTER_KEY is dev-only and AWS KMS is not wired yet']);
  }
  const keyring = await loadKeyring(
    kms,
    api.value.dataKeys.stored.map((k) => ({
      id: Buffer.from(k.id, 'hex'),
      wrapped: Buffer.from(k.wrapped, 'base64url'),
    })),
    Buffer.from(api.value.dataKeys.current, 'hex'),
  );

  const pool = createPool({
    connectionString: api.value.databaseUrl,
    max: 10,
    applicationName: 'rp-api',
  });
  const db = createDb(pool);
  const redis = new Redis({
    url: api.value.upstash.url,
    token: api.value.upstash.token,
    retry: { retries: 1 },
    // Values are opaque strings to us; auto-JSON-decoding would break the FX cache.
    automaticDeserialization: false,
  });
  const kv = createUpstashKv(redis);
  const backstop = createInProcessLimiter(BACKSTOP_PER_MINUTE, 60_000);
  const rateLimiter = createUpstashLimiter(
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_PER_MINUTE, '60 s'),
      prefix: 'rp:rl',
      analytics: false,
    }),
    backstop,
    (error) => {
      logger.warn({ err: error }, 'rate limit store unavailable; using in-process backstop');
    },
  );
  const fx = createExchangeRateApi({
    apiKey: api.value.exchangeRateApiKey,
    kv,
    fetch,
    nowMs: Date.now,
    maxRateAgeSeconds: app.value.fx.maxRateAgeSeconds,
    onCacheError: (error) => {
      logger.warn({ err: error }, 'fx cache unavailable; reading provider directly');
    },
  });

  // Built by `pnpm --filter @rp/checkout build`; overridable for container layouts.
  const assetsDir =
    process.env['CHECKOUT_ASSETS_DIR'] ??
    fileURLToPath(new URL('../../checkout/dist', import.meta.url));
  const checkout = { assets: loadCheckoutAssets(assetsDir), horizonFetch: fetch };

  const server = buildServer(
    {
      app: app.value,
      api: api.value,
      db,
      kv,
      rateLimiter,
      fx,
      keyring,
      randomBytes: cryptoRandomBytes,
      now: () => new Date(),
      logger,
      health: {
        database: async () => (await sql`select 1 as ok`.execute(db)).rows.length === 1,
        redis: () => kv.ping(),
        ledger: async () =>
          (await fetch(app.value.network.horizonUrl, { signal: AbortSignal.timeout(2000) })).ok,
      },
    },
    checkout,
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    timer.unref();
    void server
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });

  await server.listen({ host: '0.0.0.0', port: api.value.port });
}

void main();
