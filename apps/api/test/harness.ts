import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { AppConfig } from '@rp/config/app-config';
import { TESTNET } from '@rp/config/network';
import { USD_RATE, parseFxRate } from '@rp/core/money/fx-rate';
import type { Stroops } from '@rp/core/money/stroops';
import { err, ok } from '@rp/core/result';
import type { StellarAddress } from '@rp/core/stellar-address';
import { createDataKey, loadKeyring } from '@rp/security/envelope';
import { signRequest } from '@rp/security/hmac-auth';
import { createLocalDevKms } from '@rp/security/kms';
import { createLogger } from '@rp/security/logger';
import type { InjectOptions } from 'fastify';
import type { ApiConfig } from '../src/api-config.js';
import type { ApiDeps } from '../src/deps.js';
import type { FxProvider } from '../src/fx.js';
import { createMemoryKv } from '../src/kv.js';
import type { RateLimiter } from '../src/rate-limit.js';
import type { CheckoutDeps } from '../src/checkout/routes.js';
import { buildServer } from '../src/server.js';
import { db } from '../../../packages/db/test/fixtures.js';

export const KEY_ID = 'ak_2026_10';
export const KEY_SECRET = randomBytes(32);

export const appConfig: AppConfig = {
  env: 'test',
  logLevel: 'info',
  network: {
    name: 'testnet',
    passphrase: TESTNET.passphrase,
    rpcUrl: 'https://rpc.example',
    horizonUrl: 'https://horizon.example',
    usdc: TESTNET.usdc,
    merchant: `G${'M'.repeat(55)}` as StellarAddress,
    subscriptionContractId: `C${'S'.repeat(55)}`,
    maxFeeStroops: 100_000n,
    maxSorobanFeeStroops: 20_000_000n,
  },
  limits: {
    maxPayment: 5_000_000_000n as Stroops,
    maxSubscriptionPrice: 1_000_000_000n as Stroops,
    subscriptionApprovePeriods: 3,
  },
  fx: { supportedFiat: ['USD', 'GHS'], maxRateAgeSeconds: 93_600 },
};

export function apiConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    port: 0,
    checkoutBaseUrl: 'https://pay.rodium.test',
    returnUrlOrigins: ['https://app.rodium.test'],
    paymentTtlSeconds: 1200,
    plans: [
      {
        code: 'pro_monthly',
        contractPlanId: 1,
        price: 99_900_000n as Stroops,
        intervalSeconds: 30 * 86_400,
      },
      {
        code: 'too_pricey',
        contractPlanId: 2,
        price: 9_999_000_000n as Stroops,
        intervalSeconds: 30 * 86_400,
      },
    ],
    hmacKeys: new Map([[KEY_ID, KEY_SECRET]]),
    checkoutTokenKey: randomBytes(32),
    blindIndexKey: randomBytes(32),
    exchangeRateApiKey: 'testkey123',
    upstash: { url: 'https://upstash.test', token: 'x'.repeat(20) },
    databaseUrl: 'postgres://unused',
    dataKeys: { current: '00'.repeat(16), stored: [] },
    localDevKmsMasterKey: null,
    ...overrides,
  };
}

export interface Harness {
  readonly server: ReturnType<typeof buildServer>;
  readonly deps: ApiDeps;
  readonly kv: ReturnType<typeof createMemoryKv>;
  readonly logs: string[];
  readonly limiter: { allow: boolean };
  readonly fxState: { available: boolean };
  readonly health: { redis: boolean };
}

export async function harness(
  overrides: Partial<ApiConfig> = {},
  app: AppConfig = appConfig,
  checkout?: CheckoutDeps,
): Promise<Harness> {
  const kms = createLocalDevKms(randomBytes(32), randomBytes);
  const { stored } = await createDataKey(kms, randomBytes);
  const keyring = await loadKeyring(kms, [stored], stored.id);
  const kv = createMemoryKv();
  const logs: string[] = [];
  const logger = createLogger(
    { level: 'debug', service: 'api-test' },
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    }),
  );
  const limiter = { allow: true };
  const rateLimiter: RateLimiter = {
    limit: () => Promise.resolve({ allowed: limiter.allow, retryAfterSeconds: 42 }),
  };
  const fxState = { available: true };
  const ghs = parseFxRate('11.686603');
  const fx: FxProvider = {
    rateFor: (currency) => {
      if (!fxState.available) return Promise.resolve(err('fx_unavailable'));
      if (currency === 'USD') return Promise.resolve(ok({ rate: USD_RATE, asOf: new Date() }));
      if (currency === 'GHS' && ghs.ok)
        return Promise.resolve(ok({ rate: ghs.value, asOf: new Date() }));
      return Promise.resolve(err('unsupported_currency'));
    },
  };
  const health = { redis: true };
  const deps: ApiDeps = {
    app,
    api: apiConfig(overrides),
    db: db('api'),
    kv,
    rateLimiter,
    fx,
    keyring,
    randomBytes,
    now: () => new Date(),
    logger,
    health: {
      database: () => Promise.resolve(true),
      redis: () => Promise.resolve(health.redis),
      ledger: () => Promise.resolve(true),
    },
  };
  return { server: buildServer(deps, checkout), deps, kv, logs, limiter, fxState, health };
}

export interface SignOptions {
  readonly keyId?: string;
  readonly secret?: Uint8Array;
  readonly timestamp?: number;
  readonly nonce?: string;
  readonly idempotencyKey?: string | null;
  readonly headers?: Record<string, string>;
}

/** A correctly signed request (context §9.1) unless options tamper with it. */
export function signed(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  o: SignOptions = {},
): InjectOptions {
  const raw =
    body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const timestamp = String(o.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomBytes(16).toString('base64url');
  const signature = signRequest(o.secret ?? KEY_SECRET, {
    method,
    pathWithQuery: url,
    timestamp,
    nonce,
    body: raw,
  });
  return {
    method,
    url,
    ...(body === undefined ? {} : { payload: raw }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-rp-key-id': o.keyId ?? KEY_ID,
      'x-rp-timestamp': timestamp,
      'x-rp-nonce': nonce,
      'x-rp-signature': signature,
      ...(o.idempotencyKey === null || method === 'GET'
        ? {}
        : { 'idempotency-key': o.idempotencyKey ?? `idem_${randomBytes(8).toString('hex')}` }),
      ...o.headers,
    },
  };
}

export const paymentBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  merchant_order_id: 'ord_8f2c',
  customer_ref: 'usr_19ab-secret-ref',
  description: 'RodiumAI Pro credits',
  amount: { currency: 'USD', value_minor: 1999 },
  return_url: 'https://app.rodium.test/billing/return',
  ...overrides,
});
