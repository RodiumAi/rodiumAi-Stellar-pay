import type { Brand } from './brand.js';

/** Milliseconds since the Unix epoch. */
export type Instant = Brand<number, 'Instant'>;

/** Milliseconds. */
export type Duration = Brand<number, 'Duration'>;

export const SECOND = 1000 as Duration;
export const DAY = (86_400 * SECOND) as Duration;

export function instant(ms: number): Instant {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`Invalid instant: ${String(ms)}`);
  }
  return ms as Instant;
}

export function duration(ms: number): Duration {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`Invalid duration: ${String(ms)}`);
  }
  return ms as Duration;
}

export function addDuration(at: Instant, d: Duration): Instant {
  return instant(at + d);
}
