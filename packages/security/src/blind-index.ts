import { createHmac } from 'node:crypto';

export function normalizeForIndex(value: string): string {
  return value.trim().normalize('NFC');
}

/**
 * Deterministic lookup token for an encrypted field (context §12.2). The key must
 * be separate from every encryption key.
 */
export function blindIndex(key: Uint8Array, value: string): Buffer {
  if (key.length < 32) {
    throw new Error('Blind-index key must be at least 32 bytes');
  }
  return createHmac('sha256', key).update(normalizeForIndex(value), 'utf8').digest();
}
