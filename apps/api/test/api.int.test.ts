import { randomBytes } from 'node:crypto';
import { findPaymentById } from '@rp/db/payments';
import { blindIndex } from '@rp/security/blind-index';
import { decryptField } from '@rp/security/envelope';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../packages/db/test/fixtures.js';
import { harness, paymentBody, signed, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});

type Json = Record<string, unknown> & { error?: { code: string; message: string } };
const json = (body: string): Json => JSON.parse(body) as Json;

describe('POST /v1/payments', () => {
  it('creates a USD payment 1:1 and never returns the customer ref', async () => {
    const res = await h.server.inject(signed('POST', '/v1/payments', paymentBody()));
    expect(res.statusCode).toBe(201);
    const body = json(res.body);
    expect(body).toMatchObject({
      status: 'pending',
      merchant_order_id: 'ord_8f2c',
      amount_due: { asset: 'USDC', value: '19.9900000' },
      amount_received: { asset: 'USDC', value: '0.0000000' },
      fiat: { currency: 'USD', value_minor: 1999 },
    });
    expect(String(body['checkout_url'])).toMatch(
      /^https:\/\/pay\.rodium\.test\/c\/[A-Za-z0-9_-]{43}$/,
    );
    expect(res.body).not.toContain('usr_19ab');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('stores the customer ref encrypted (AAD-bound) with a blind index', async () => {
    const res = await h.server.inject(signed('POST', '/v1/payments', paymentBody()));
    const id = String(json(res.body)['id']);
    const row = await findPaymentById(db('worker'), id);
    if (row === undefined) throw new Error('missing row');
    expect(row.customer_ref_enc.toString('utf8')).not.toContain('usr_19ab');
    const plain = decryptField(h.deps.keyring, row.customer_ref_enc, {
      table: 'payments',
      column: 'customer_ref_enc',
      rowId: id,
    });
    expect(plain.ok && plain.value.toString('utf8')).toBe('usr_19ab-secret-ref');
    expect(
      row.customer_ref_bidx.equals(blindIndex(h.deps.api.blindIndexKey, 'usr_19ab-secret-ref')),
    ).toBe(true);
    expect(row.memo).toMatch(/^RP[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(row.destination).toBe(h.deps.app.network.merchant);
    expect(row.asset_issuer).toBe(h.deps.app.network.usdc.issuer);
  });

  it('quotes GHS through the FX provider, rounding up to the cent', async () => {
    const res = await h.server.inject(
      signed(
        'POST',
        '/v1/payments',
        paymentBody({ amount: { currency: 'GHS', value_minor: 10_000 } }),
      ),
    );
    expect(res.statusCode).toBe(201);
    expect(json(res.body)).toMatchObject({
      amount_due: { value: '8.5600000' },
      fiat: { fx_rate: '11.686603000000000000' },
    });
  });

  it('replays the original response for the same Idempotency-Key and body', async () => {
    const first = await h.server.inject(
      signed('POST', '/v1/payments', paymentBody(), { idempotencyKey: 'idem_replay_1' }),
    );
    const again = await h.server.inject(
      signed('POST', '/v1/payments', paymentBody(), { idempotencyKey: 'idem_replay_1' }),
    );
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(json(again.body)['id']).toBe(json(first.body)['id']);
    expect(json(again.body)['checkout_url']).toBe(json(first.body)['checkout_url']);
  });

  it('rejects the same Idempotency-Key with a different body (409)', async () => {
    await h.server.inject(
      signed('POST', '/v1/payments', paymentBody(), { idempotencyKey: 'idem_conflict_1' }),
    );
    const res = await h.server.inject(
      signed('POST', '/v1/payments', paymentBody({ description: 'different' }), {
        idempotencyKey: 'idem_conflict_1',
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(json(res.body).error?.code).toBe('idempotency_conflict');
  });

  it.each<[string, Record<string, unknown>, number, string]>([
    [
      'bad currency format',
      { amount: { currency: 'usd', value_minor: 1 } },
      400,
      'validation_failed',
    ],
    [
      'non-integer amount',
      { amount: { currency: 'USD', value_minor: 1.5 } },
      400,
      'validation_failed',
    ],
    ['zero amount', { amount: { currency: 'USD', value_minor: 0 } }, 400, 'validation_failed'],
    ['description too long', { description: 'x'.repeat(141) }, 400, 'validation_failed'],
    [
      'currency not accepted',
      { amount: { currency: 'EUR', value_minor: 100 } },
      422,
      'unsupported_currency',
    ],
    [
      'amount over cap',
      { amount: { currency: 'USD', value_minor: 50_001 } },
      422,
      'amount_exceeds_limit',
    ],
    ['return_url other host', { return_url: 'https://evil.test/x' }, 422, 'invalid_return_url'],
    ['return_url http', { return_url: 'http://app.rodium.test/x' }, 422, 'invalid_return_url'],
    [
      'return_url other port',
      { return_url: 'https://app.rodium.test:8443/x' },
      422,
      'invalid_return_url',
    ],
    [
      'return_url with credentials',
      { return_url: 'https://u:p@app.rodium.test/x' },
      422,
      'invalid_return_url',
    ],
    ['return_url not a URL', { return_url: 'javascript:alert(1)' }, 422, 'invalid_return_url'],
  ])('rejects %s', async (_name, overrides, status, code) => {
    const res = await h.server.inject(signed('POST', '/v1/payments', paymentBody(overrides)));
    expect(res.statusCode).toBe(status);
    expect(json(res.body).error?.code).toBe(code);
    expect(Object.keys(json(res.body))).toEqual(['error']);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await h.server.inject(
      signed('POST', '/v1/payments', paymentBody(), { idempotencyKey: null }),
    );
    expect(res.statusCode).toBe(400);
    expect(json(res.body).error?.code).toBe('idempotency_key_required');
  });

  it('rejects invalid JSON, wrong content type and bodies over 16 KB', async () => {
    expect((await h.server.inject(signed('POST', '/v1/payments', '{not json'))).statusCode).toBe(
      400,
    );
    const wrongType = signed('POST', '/v1/payments', paymentBody(), {
      headers: { 'content-type': 'text/plain' },
    });
    expect((await h.server.inject(wrongType)).statusCode).toBe(415);
    const big = await h.server.inject(
      signed('POST', '/v1/payments', paymentBody({ description: 'x'.repeat(17_000) })),
    );
    expect(big.statusCode).toBe(413);
    expect(json(big.body).error?.code).toBe('payload_too_large');
  });

  it('returns 503 when the FX rate is unavailable', async () => {
    h.fxState.available = false;
    try {
      const res = await h.server.inject(
        signed(
          'POST',
          '/v1/payments',
          paymentBody({ amount: { currency: 'GHS', value_minor: 100 } }),
        ),
      );
      expect(res.statusCode).toBe(503);
      expect(json(res.body).error?.code).toBe('fx_unavailable');
    } finally {
      h.fxState.available = true;
    }
  });
});

describe('country rule', () => {
  const sub = (o: Record<string, unknown> = {}) => ({
    merchant_subscription_ref: 'sub_country',
    customer_ref: 'usr_country',
    plan_code: 'pro_monthly',
    return_url: 'https://app.rodium.test/billing/return',
    ...o,
  });

  it('accepts an allowed country and an omitted one', async () => {
    for (const body of [paymentBody({ customer_country: 'GH' }), paymentBody()]) {
      expect((await h.server.inject(signed('POST', '/v1/payments', body))).statusCode).toBe(201);
    }
  });

  it.each<[string, string, Record<string, unknown>]>([
    ['a payment', '/v1/payments', paymentBody({ customer_country: 'IR' })],
    ['a subscription', '/v1/subscriptions', sub({ customer_country: 'KP' })],
  ])('refuses %s from a blocked country with 422 country_not_allowed', async (_n, url, body) => {
    const res = await h.server.inject(signed('POST', url, body));
    expect(res.statusCode).toBe(422);
    expect(json(res.body).error?.code).toBe('country_not_allowed');
  });

  it.each([['gh'], ['GHA'], ['']])('rejects a malformed country %j', async (c) => {
    const res = await h.server.inject(
      signed('POST', '/v1/payments', paymentBody({ customer_country: c })),
    );
    expect(res.statusCode).toBe(400);
    expect(json(res.body).error?.code).toBe('validation_failed');
  });

  it('can require the country, and block extra countries', async () => {
    const strict = await harness({ requireCustomerCountry: true, blockedCountries: ['GH'] });
    const missing = await strict.server.inject(signed('POST', '/v1/payments', paymentBody()));
    expect(missing.statusCode).toBe(400);
    const ghana = await strict.server.inject(
      signed('POST', '/v1/payments', paymentBody({ customer_country: 'GH' })),
    );
    expect(json(ghana.body).error?.code).toBe('country_not_allowed');
    const kenya = await strict.server.inject(
      signed('POST', '/v1/payments', paymentBody({ customer_country: 'KE' })),
    );
    expect(kenya.statusCode).toBe(201);
  });
});

describe('authentication (context §9.1)', () => {
  const create = (o = {}) => signed('POST', '/v1/payments', paymentBody(), o);

  it.each<[string, () => ReturnType<typeof signed>]>([
    ['missing headers', () => ({ method: 'POST', url: '/v1/payments', payload: paymentBody() })],
    ['unknown key', () => create({ keyId: 'ak_unknown' })],
    ['wrong secret', () => create({ secret: randomBytes(32) })],
    ['clock skew over 300 s', () => create({ timestamp: Math.floor(Date.now() / 1000) - 301 })],
    ['short nonce', () => create({ nonce: 'abc' })],
  ])('rejects %s with 401 and no detail', async (_name, make) => {
    const res = await h.server.inject(make());
    expect(res.statusCode).toBe(401);
    expect(json(res.body)).toEqual({ error: { code: 'unauthorized', message: 'Unauthorized' } });
  });

  it('rejects a tampered body', async () => {
    const req = create();
    const res = await h.server.inject({
      ...req,
      payload: JSON.stringify(paymentBody({ description: 'tampered' })),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a replayed nonce', async () => {
    const req = signed('GET', '/v1/payments/00000000-0000-7000-8000-000000000000');
    expect((await h.server.inject(req)).statusCode).toBe(404);
    expect((await h.server.inject(req)).statusCode).toBe(401);
  });

  it('fails closed (503) when the nonce store is down', async () => {
    h.kv.down = true;
    try {
      const res = await h.server.inject(create());
      expect(res.statusCode).toBe(503);
      expect(json(res.body).error?.code).toBe('service_unavailable');
    } finally {
      h.kv.down = false;
    }
  });

  it('rate-limits per key with Retry-After', async () => {
    h.limiter.allow = false;
    try {
      const res = await h.server.inject(create());
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('42');
    } finally {
      h.limiter.allow = true;
    }
  });
});

describe('GET /v1/payments/:id', () => {
  it('returns the payment without the customer ref', async () => {
    const created = json(
      (await h.server.inject(signed('POST', '/v1/payments', paymentBody()))).body,
    );
    const res = await h.server.inject(signed('GET', `/v1/payments/${String(created['id'])}`));
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toMatchObject({ id: created['id'], status: 'pending' });
    expect(res.body).not.toContain('usr_19ab');
    expect(res.body).not.toContain('checkout_url');
  });

  it.each(['00000000-0000-7000-8000-000000000000', 'not-a-uuid'])('404 for %s', async (id) => {
    const res = await h.server.inject(signed('GET', `/v1/payments/${id}`));
    expect(res.statusCode).toBe(404);
    expect(json(res.body).error?.code).toBe('payment_not_found');
  });
});

describe('subscriptions', () => {
  const subBody = (o: Record<string, unknown> = {}) => ({
    merchant_subscription_ref: 'sub_abc',
    customer_ref: 'usr_19ab-secret-ref',
    plan_code: 'pro_monthly',
    return_url: 'https://app.rodium.test/billing/return',
    ...o,
  });

  it('creates an incomplete subscription at the plan price', async () => {
    const res = await h.server.inject(signed('POST', '/v1/subscriptions', subBody()));
    expect(res.statusCode).toBe(201);
    expect(json(res.body)).toMatchObject({
      status: 'incomplete',
      plan_code: 'pro_monthly',
      price: { asset: 'USDC', value: '9.9900000' },
      interval_seconds: 2_592_000,
    });
    expect(String(json(res.body)['checkout_url'])).toMatch(/\/c\/[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toContain('usr_19ab');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['unknown plan', { plan_code: 'gold' }, 'unknown_plan'],
    ['plan over the price cap', { plan_code: 'too_pricey' }, 'amount_exceeds_limit'],
    ['bad return_url', { return_url: 'https://evil.test' }, 'invalid_return_url'],
  ])('rejects %s', async (_n, o, code) => {
    const res = await h.server.inject(signed('POST', '/v1/subscriptions', subBody(o)));
    expect(res.statusCode).toBe(422);
    expect(json(res.body).error?.code).toBe(code);
  });

  it('cancels idempotently and emits subscription.canceled once', async () => {
    const id = String(
      json((await h.server.inject(signed('POST', '/v1/subscriptions', subBody()))).body)['id'],
    );
    const first = await h.server.inject(signed('POST', `/v1/subscriptions/${id}/cancel`, {}));
    const second = await h.server.inject(signed('POST', `/v1/subscriptions/${id}/cancel`, {}));
    expect(first.statusCode).toBe(200);
    expect(json(first.body)).toMatchObject({ status: 'canceled' });
    expect(second.statusCode).toBe(200);
    const events = await db('worker')
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', id)
      .execute();
    expect(events).toEqual([{ event_type: 'subscription.canceled' }]);
    const got = await h.server.inject(signed('GET', `/v1/subscriptions/${id}`));
    expect(json(got.body)).toMatchObject({ id, status: 'canceled' });
  });

  it('404s unknown subscriptions', async () => {
    const res = await h.server.inject(
      signed('POST', '/v1/subscriptions/00000000-0000-7000-8000-000000000000/cancel', {}),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('health', () => {
  it('live and ready need no auth', async () => {
    expect((await h.server.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    const ready = await h.server.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(json(ready.body)).toEqual({
      status: 'ready',
      checks: { database: true, redis: true, ledger: true },
    });
  });

  it('ready reports 503 when a dependency is down', async () => {
    h.health.redis = false;
    try {
      const ready = await h.server.inject({ method: 'GET', url: '/v1/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(json(ready.body)).toMatchObject({ checks: { redis: false } });
    } finally {
      h.health.redis = true;
    }
  });
});

describe('logging', () => {
  it('never logs customer refs, signatures or bodies', async () => {
    await h.server.inject(signed('POST', '/v1/payments', paymentBody()));
    await h.server.inject(
      signed('POST', '/v1/payments', paymentBody(), { secret: randomBytes(32) }),
    );
    const all = h.logs.join('');
    expect(all).toContain('request');
    expect(all).not.toContain('usr_19ab');
    expect(all).not.toMatch(/x-rp-signature/i);
  });

  it('unknown routes are 404 with the standard error shape', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(json(res.body)).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});
