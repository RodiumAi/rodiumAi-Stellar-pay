import type { RandomBytes } from '@rp/core/random';

/** Context §10.1: 10s, 1m, 5m, 30m, 2h, 6h, 12h, then `dead`. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000,
];

/**
 * When to try again after the `failedAttempts`-th consecutive failure, with ±10% jitter;
 * null means give up (`dead`).
 */
export function nextAttemptAt(
  failedAttempts: number,
  now: Date,
  randomBytes: RandomBytes,
): Date | null {
  const base = WEBHOOK_RETRY_DELAYS_MS[failedAttempts - 1];
  if (base === undefined) return null;
  const [byte = 128] = randomBytes(1);
  const jitter = ((byte / 255) * 0.2 - 0.1) * base;
  return new Date(now.getTime() + Math.round(base + jitter));
}
