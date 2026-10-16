import type { Redis } from '@upstash/redis';

/**
 * The only way to write to Redis (context §8.1): every write carries a TTL, so the
 * database can run with eviction and losing any key is harmless.
 */
export interface KvStore {
  /** SET key NX EX ttl — true when this call created the key. Throws if the store is down. */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  ping(): Promise<boolean>;
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 86_400) {
    throw new RangeError('Redis writes need a TTL between 1 s and 7 days');
  }
}

/** `redis` must be created with `automaticDeserialization: false` (values are opaque strings). */
export function createUpstashKv(redis: Redis): KvStore {
  return {
    async setIfAbsent(key, ttlSeconds) {
      assertTtl(ttlSeconds);
      return (await redis.set(key, '1', { nx: true, ex: ttlSeconds })) === 'OK';
    },
    async get(key) {
      const value = await redis.get<string>(key);
      return value ?? null;
    },
    async set(key, value, ttlSeconds) {
      assertTtl(ttlSeconds);
      await redis.set(key, value, { ex: ttlSeconds });
    },
    async ping() {
      return (await redis.ping()) === 'PONG';
    },
  };
}

/** Runs synchronous work as a promise so errors always arrive as rejections. */
function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** In-memory store for tests and local runs without Upstash. */
export function createMemoryKv(now: () => number = Date.now): KvStore & { down: boolean } {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry !== undefined && entry.expiresAt <= now()) data.delete(key);
    return data.get(key);
  };
  const store = {
    down: false,
    setIfAbsent: (key: string, ttlSeconds: number) =>
      settle(() => {
        available();
        assertTtl(ttlSeconds);
        if (live(key) !== undefined) return false;
        data.set(key, { value: '1', expiresAt: now() + ttlSeconds * 1000 });
        return true;
      }),
    get: (key: string) =>
      settle(() => {
        available();
        return live(key)?.value ?? null;
      }),
    set: (key: string, value: string, ttlSeconds: number) =>
      settle(() => {
        available();
        assertTtl(ttlSeconds);
        data.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      }),
    ping: () => Promise.resolve(!store.down),
  };
  const available = (): void => {
    if (store.down) throw new Error('kv unavailable');
  };
  return store;
}
