import { randomBytes } from 'node:crypto';
import { generateMemo } from '@rp/core/memo';
import { cryptoRandomBytes } from '@rp/core/random';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import type pg from 'pg';
import { afterAll, inject } from 'vitest';
import { createDb, createPool, type Db } from '../src/connection.js';
import type { NewPayment, NewSubscription } from '../src/schema.js';

export type Role = 'admin' | 'owner' | 'api' | 'worker' | 'readonly';

const pools: pg.Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

export function pool(role: Role, max = 5): pg.Pool {
  const p = createPool({
    connectionString: new Map(Object.entries(inject('dbUrls'))).get(role) ?? '',
    max,
    applicationName: `test-${role}`,
  });
  pools.push(p);
  return p;
}

export function db(role: Role, max = 5): Db {
  return createDb(pool(role, max));
}

export const newId = (): string => uuidV7(instant(Date.now()), cryptoRandomBytes);

export function newPayment(overrides: Partial<NewPayment> = {}): NewPayment {
  return {
    id: newId(),
    idempotency_key: `idem_${randomBytes(8).toString('hex')}`,
    request_hash: randomBytes(32),
    merchant_order_id: 'ord_1',
    customer_ref_enc: randomBytes(48),
    customer_ref_bidx: randomBytes(32),
    description: 'Pro plan',
    fiat_currency: 'USD',
    fiat_amount_minor: 1999n,
    fx_rate: '1',
    asset_code: 'USDC',
    asset_issuer: `G${'A'.repeat(55)}`,
    destination: `G${'B'.repeat(55)}`,
    memo: generateMemo(cryptoRandomBytes),
    amount_due_stroops: 199_900_000n,
    checkout_token_hash: randomBytes(32),
    return_url: 'https://app.rodium.ai/billing/return',
    expires_at: new Date(Date.now() + 20 * 60_000),
    ...overrides,
  };
}

export function newSubscription(overrides: Partial<NewSubscription> = {}): NewSubscription {
  return {
    id: newId(),
    idempotency_key: `idem_${randomBytes(8).toString('hex')}`,
    request_hash: randomBytes(32),
    merchant_subscription_ref: 'sub_1',
    customer_ref_enc: randomBytes(48),
    customer_ref_bidx: randomBytes(32),
    plan_code: 'pro_monthly',
    contract_plan_id: 1,
    price_stroops: 99_900_000n,
    interval_seconds: 30 * 86_400,
    checkout_token_hash: randomBytes(32),
    return_url: 'https://app.rodium.ai/billing/return',
    ...overrides,
  };
}
