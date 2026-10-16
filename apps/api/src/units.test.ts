import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadApiConfig } from './api-config.js';
import { createExchangeRateApi } from './fx.js';
import { createMemoryKv } from './kv.js';
import { createInProcessLimiter, createUpstashLimiter } from './rate-limit.js';

describe('KvStore (context §8.1)', () => {
  it('requires a TTL on every write', async () => {
    const kv = createMemoryKv();
    await expect(kv.set('k', 'v', 0)).rejects.toThrow(RangeError);
    await expect(kv.setIfAbsent('k', 8 * 86_400)).rejects.toThrow(RangeError);
    await expect(kv.set('k', 'v', 1.5)).rejects.toThrow(RangeError);
  });

  it('SET NX semantics with expiry', async () => {
    let now = 0;
    const kv = createMemoryKv(() => now);
    expect(await kv.setIfAbsent('n', 10)).toBe(true);
    expect(await kv.setIfAbsent('n', 10)).toBe(false);
    now = 10_000;
    expect(await kv.setIfAbsent('n', 10)).toBe(true);
    await kv.set('x', 'v', 5);
    expect(await kv.get('x')).toBe('v');
    now = 20_000;
    expect(await kv.get('x')).toBeNull();
  });
});

describe('rate limiting (context §8.2)', () => {
  it('in-process fixed window', async () => {
    let now = 0;
    const l = createInProcessLimiter(2, 60_000, () => now);
    expect((await l.limit('a')).allowed).toBe(true);
    expect((await l.limit('a')).allowed).toBe(true);
    const third = await l.limit('a');
    expect(third).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect((await l.limit('b')).allowed).toBe(true);
    now = 60_000;
    expect((await l.limit('a')).allowed).toBe(true);
  });

  it('fails open to the in-process backstop when Upstash errors', async () => {
    const onFallback = vi.fn();
    const backstop = createInProcessLimiter(1, 60_000);
    const l = createUpstashLimiter(
      { limit: () => Promise.reject(new Error('upstash down')) },
      backstop,
      onFallback,
    );
    expect((await l.limit('k')).allowed).toBe(true);
    expect((await l.limit('k')).allowed).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(2);
  });

  it('uses Upstash when available', async () => {
    const reset = Date.now() + 30_000;
    const l = createUpstashLimiter(
      {
        limit: () =>
          Promise.resolve({
            success: false,
            limit: 1,
            remaining: 0,
            reset,
            pending: Promise.resolve(),
          }),
      },
      createInProcessLimiter(100, 60_000),
      () => undefined,
    );
    const d = await l.limit('k');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(29);
  });
});

describe('ExchangeRate-API provider (context §6 Quote)', () => {
  const NOW = 1_760_500_000_000;
  const rates = (lastUpdate: number, extra: Record<string, number> = {}) => ({
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: lastUpdate,
    time_next_update_unix: lastUpdate + 86_400,
    conversion_rates: { USD: 1, GHS: 11.686603, XOF: 600, TNY: 1e-7, ...extra },
  });
  const make = (body: unknown, status = 200, maxAge = 93_600) => {
    const kv = createMemoryKv(() => NOW);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );
    const fx = createExchangeRateApi({
      apiKey: 'k3y',
      kv,
      fetch,
      nowMs: () => NOW,
      maxRateAgeSeconds: maxAge,
      onCacheError: () => undefined,
    });
    return { fx, fetch, kv };
  };

  it('USD never calls the provider', async () => {
    const { fx, fetch } = make({});
    expect((await fx.rateFor('USD')).ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caches the rate table: one provider call per update period', async () => {
    const { fx, fetch } = make(rates(NOW / 1000 - 3600));
    const first = await fx.rateFor('GHS');
    const second = await fx.rateFor('XOF');
    expect(first.ok && first.value.rate).toBe(11_686_603_000_000_000_000n);
    expect(second.ok && second.value.rate).toBe(600_000_000_000_000_000_000n);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('converts exponent-form numbers exactly', async () => {
    const { fx } = make(rates(NOW / 1000));
    const tiny = await fx.rateFor('TNY');
    expect(tiny.ok && tiny.value.rate).toBe(100_000_000_000n);
  });

  it('refuses stale rates and unknown currencies', async () => {
    expect(await make(rates(NOW / 1000 - 93_601)).fx.rateFor('GHS')).toEqual({
      ok: false,
      error: 'fx_unavailable',
    });
    expect(await make(rates(NOW / 1000)).fx.rateFor('ZZZ')).toEqual({
      ok: false,
      error: 'unsupported_currency',
    });
  });

  it('provider errors or bad payloads are fx_unavailable', async () => {
    expect(await make({}, 500).fx.rateFor('GHS')).toEqual({ ok: false, error: 'fx_unavailable' });
    expect(await make({ result: 'error', 'error-type': 'invalid-key' }).fx.rateFor('GHS')).toEqual({
      ok: false,
      error: 'fx_unavailable',
    });
  });

  it('still works when the cache is down', async () => {
    const { fx, kv } = make(rates(NOW / 1000));
    kv.down = true;
    expect((await fx.rateFor('GHS')).ok).toBe(true);
  });
});

describe('loadApiConfig', () => {
  const key = () => randomBytes(32).toString('base64url');
  const valid = {
    CHECKOUT_BASE_URL: 'https://pay.rodium.test/',
    RETURN_URL_ORIGINS: 'https://app.rodium.test, http://localhost:3000',
    SUBSCRIPTION_PLANS: JSON.stringify([
      { code: 'pro_monthly', contractPlanId: 1, price: '9.99', intervalSeconds: 2_592_000 },
    ]),
    API_HMAC_KEYS: `ak_2026_10:${key()},ak_2027_01:${key()}`,
    CHECKOUT_TOKEN_KEY: key(),
    BLIND_INDEX_KEY: key(),
    EXCHANGERATE_API_KEY: 'abcdef123456',
    UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 't'.repeat(40),
    DATABASE_URL_API: 'postgresql://rp_api:pw@localhost:54322/rodium_pay_dev',
    FIELD_DATA_KEYS: `${'ab'.repeat(16)}:${key()}`,
    FIELD_DATA_KEY_CURRENT: 'ab'.repeat(16),
  };

  it('loads a valid config', () => {
    const r = loadApiConfig(valid);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.checkoutBaseUrl).toBe('https://pay.rodium.test');
    expect(r.value.returnUrlOrigins).toEqual(['https://app.rodium.test', 'http://localhost:3000']);
    expect(r.value.plans[0]?.price).toBe(99_900_000n);
    expect(r.value.hmacKeys.size).toBe(2);
    expect(r.value.port).toBe(8080);
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'origin with a path',
      { RETURN_URL_ORIGINS: 'https://app.rodium.test/billing' },
      'RETURN_URL_ORIGINS',
    ],
    [
      'short HMAC secret',
      { API_HMAC_KEYS: `ak_x:${randomBytes(8).toString('base64url')}` },
      'API_HMAC_KEYS',
    ],
    [
      'three HMAC keys',
      { API_HMAC_KEYS: [1, 2, 3].map((i) => `ak_${String(i)}:${key()}`).join(',') },
      'API_HMAC_KEYS',
    ],
    ['plans not JSON', { SUBSCRIPTION_PLANS: '{' }, 'SUBSCRIPTION_PLANS'],
    [
      'plan interval < 1 day',
      {
        SUBSCRIPTION_PLANS: JSON.stringify([
          { code: 'x', contractPlanId: 1, price: '1', intervalSeconds: 60 },
        ]),
      },
      'SUBSCRIPTION_PLANS',
    ],
    [
      'current data key missing',
      { FIELD_DATA_KEY_CURRENT: 'cd'.repeat(16) },
      'FIELD_DATA_KEY_CURRENT',
    ],
  ])('rejects %s', (_n, override, field) => {
    const r = loadApiConfig({ ...valid, ...override });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.startsWith(field))).toBe(true);
  });

  it('rejects a plan with an invalid price', () => {
    const r = loadApiConfig({
      ...valid,
      SUBSCRIPTION_PLANS: JSON.stringify([
        { code: 'x', contractPlanId: 1, price: '1.00000001', intervalSeconds: 86_400 },
      ]),
    });
    expect(r.ok).toBe(false);
  });
});
