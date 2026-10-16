import type { Ratelimit } from '@upstash/ratelimit';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  limit(identifier: string): Promise<RateLimitDecision>;
}

/** Fixed-window counter per identifier; the backstop when Upstash is unreachable. */
export function createInProcessLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    limit(identifier) {
      const t = now();
      let w = windows.get(identifier);
      if (w === undefined || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(identifier, w);
      }
      w.count += 1;
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
      }
      return Promise.resolve({
        allowed: w.count <= max,
        retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)),
      });
    },
  };
}

/**
 * Upstash sliding window (context §8.2). Fails open: if Upstash errors, the lower
 * in-process limit still applies, so an outage never removes rate limiting entirely.
 */
export function createUpstashLimiter(
  ratelimit: Pick<Ratelimit, 'limit'>,
  backstop: RateLimiter,
  onFallback: (error: unknown) => void,
): RateLimiter {
  return {
    async limit(identifier) {
      try {
        const res = await ratelimit.limit(identifier);
        return {
          allowed: res.success,
          retryAfterSeconds: Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
        };
      } catch (error) {
        onFallback(error);
        return backstop.limit(identifier);
      }
    },
  };
}
