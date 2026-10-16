import { randomBytes } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import { createUpstashKv } from '../src/kv.js';
import { createInProcessLimiter, createUpstashLimiter } from '../src/rate-limit.js';

// Real @upstash/redis client against Redis + serverless-redis-http (`scripts/redis-local.sh`).
const redis = new Redis({
  url: process.env['RP_TEST_UPSTASH_URL'] ?? 'http://localhost:8079',
  token: process.env['RP_TEST_UPSTASH_TOKEN'] ?? 'rp-local-token',
  // Same client options as apps/api/src/main.ts.
  automaticDeserialization: false,
});
const kv = createUpstashKv(redis);
const unique = () => `rp:test:${randomBytes(6).toString('hex')}`;

describe('Upstash KvStore over the REST protocol', () => {
  it('pings', async () => {
    expect(await kv.ping()).toBe(true);
  });

  it('SET NX EX claims a nonce exactly once and sets a TTL', async () => {
    const key = unique();
    expect(await kv.setIfAbsent(key, 600)).toBe(true);
    expect(await kv.setIfAbsent(key, 600)).toBe(false);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('stores values only with a TTL', async () => {
    const key = unique();
    await kv.set(key, '{"a":1}', 60);
    expect(await kv.get(key)).toBe('{"a":1}');
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    await expect(kv.set(key, 'x', 0)).rejects.toThrow(RangeError);
  });

  it('parallel nonce claims: exactly one winner', async () => {
    const key = unique();
    const results = await Promise.all(Array.from({ length: 20 }, () => kv.setIfAbsent(key, 600)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('Upstash sliding-window rate limit', () => {
  // @upstash/ratelimit's Lua scripts use an Upstash-only shebang flag (allow-key-locking)
  // that no self-hosted Redis accepts, so locally we prove the fail-open path keeps
  // limiting enforced. The live path was verified against real Upstash (learning log S6).
  it('keeps limiting enforced through the in-process backstop when the store rejects it', async () => {
    const fallbacks: unknown[] = [];
    const limiter = createUpstashLimiter(
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, '60 s'),
        prefix: unique(),
        analytics: false,
      }),
      createInProcessLimiter(2, 60_000),
      (e) => fallbacks.push(e),
    );
    const decisions = [];
    for (let i = 0; i < 3; i++) decisions.push((await limiter.limit('ak_test')).allowed);
    expect(decisions).toEqual([true, true, false]);
    expect(fallbacks).toHaveLength(3);
  });
});
