import type { RandomBytes } from './random.js';
import type { Instant } from './time.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

/** RFC 9562 UUIDv7: 48-bit millisecond timestamp, then 74 random bits. */
export function uuidV7(now: Instant, randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  if (bytes.length !== 16) {
    throw new Error('randomBytes returned the wrong length');
  }
  const timestamp = new DataView(new ArrayBuffer(8));
  timestamp.setBigUint64(0, BigInt(now));
  bytes.set(new Uint8Array(timestamp.buffer, 2, 6), 0);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
