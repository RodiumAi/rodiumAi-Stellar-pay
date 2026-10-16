import { KMS } from '@aws-sdk/client-kms';
import { loadConfig } from '@rp/config/app-config';
import { resolveSecretFiles } from '@rp/config/secret-files';
import { cryptoRandomBytes } from '@rp/core/random';
import { createDb, createPool } from '@rp/db/connection';
import { createAwsKms } from '@rp/security/aws-kms';
import { loadKeyring } from '@rp/security/envelope';
import { createLocalDevKms, type Kms } from '@rp/security/kms';
import { createLogger } from '@rp/security/logger';
import { startTracing } from '@rp/telemetry/tracing';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { rpc } from '@stellar/stellar-sdk';
import { sql } from 'kysely';
import { fileURLToPath } from 'node:url';
import { loadApiConfig } from './api-config.js';
import { loadCheckoutAssets } from './checkout/routes.js';
import { loadDocsSite } from './docs/routes.js';
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
  const env = resolveSecretFiles(process.env);
  if (!env.ok) fail(env.error);
  const app = loadConfig(env.value);
  if (!app.ok) fail(app.error.issues);
  const api = loadApiConfig(env.value);
  if (!api.ok) fail(api.error);
  const logger = createLogger({ level: app.value.logLevel, service: 'api' });
  const tracing = startTracing({ service: 'rp-api', env: env.value });

  let kms: Kms;
  if (api.value.awsKmsKeyId !== null) {
    // Region and credentials come from the standard AWS chain (IRSA/ECS role in staging/prod).
    kms = createAwsKms(new KMS({ maxAttempts: 3 }), api.value.awsKmsKeyId);
  } else if (api.value.localDevKmsMasterKey !== null && app.value.env !== 'production') {
    kms = createLocalDevKms(api.value.localDevKmsMasterKey, cryptoRandomBytes);
  } else {
    fail(['No KMS configured: set AWS_KMS_KEY_ID (LOCAL_DEV_KMS_MASTER_KEY is dev-only)']);
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
  const soroban = new rpc.Server(app.value.network.rpcUrl, {
    allowHttp: app.value.network.rpcUrl.startsWith('http://'),
  });
  const checkout = { assets: loadCheckoutAssets(assetsDir), horizonFetch: fetch, soroban };
  // Documentation site served at / (built by `pnpm --filter @rp/docs build`). Optional: the
  // API runs without it, it just answers 404 at /.
  const docsDir =
    process.env['DOCS_ASSETS_DIR'] ?? fileURLToPath(new URL('../../docs/dist', import.meta.url));
  let docs;
  try {
    docs = loadDocsSite(docsDir);
  } catch (error) {
    logger.warn({ err: error }, 'documentation site not found; serving the API only');
  }

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
    docs,
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    timer.unref();
    void server
      .close()
      .then(() => Promise.all([pool.end(), tracing.shutdown()]))
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
