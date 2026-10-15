import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newPaymentId, newSubscriptionId, parsePaymentId, parseSubscriptionId } from './ids.js';
import { cryptoRandomBytes } from './random.js';
import { parseStellarAddress } from './stellar-address.js';
import { instant } from './time.js';
import { isUuidV7, uuidV7 } from './uuid-v7.js';

const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });
const timestamps = fc.integer({ min: 0, max: 2 ** 48 - 1 }).map(instant);

describe('uuidV7', () => {
  it('produces valid v7 UUIDs that embed the timestamp', () => {
    fc.assert(
      fc.property(timestamps, bytes16, (now, b) => {
        const id = uuidV7(now, () => b.slice());
        expect(isUuidV7(id)).toBe(true);
        expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
      }),
    );
  });

  it('sorts by creation time', () => {
    fc.assert(
      fc.property(timestamps, timestamps, bytes16, bytes16, (a, b, ra, rb) => {
        fc.pre(a < b);
        expect(uuidV7(a, () => ra.slice()) < uuidV7(b, () => rb.slice())).toBe(true);
      }),
    );
  });

  it('rejects a random source returning the wrong length', () => {
    expect(() => uuidV7(instant(0), () => new Uint8Array(8))).toThrow();
  });

  it('is unique with the real random source', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidV7(instant(1), cryptoRandomBytes)));
    expect(ids.size).toBe(1000);
  });
});

describe('ids', () => {
  const now = instant(1_760_000_000_000);

  it('creates and parses payment and subscription IDs', () => {
    const p = newPaymentId(now, cryptoRandomBytes);
    const s = newSubscriptionId(now, cryptoRandomBytes);
    expect(parsePaymentId(p)).toEqual({ ok: true, value: p });
    expect(parseSubscriptionId(s)).toEqual({ ok: true, value: s });
  });

  it.each([
    '',
    'not-a-uuid',
    '0190a0a0-0000-4000-8000-000000000000',
    '0190A0A0-0000-7000-8000-000000000000',
  ])('rejects %j', (input) => {
    expect(parsePaymentId(input)).toEqual({ ok: false, error: 'invalid_id' });
    expect(parseSubscriptionId(input)).toEqual({ ok: false, error: 'invalid_id' });
  });
});

describe('parseStellarAddress', () => {
  it('accepts account and contract strkeys by shape', () => {
    const g = `G${'A'.repeat(55)}`;
    const c = `C${'B'.repeat(55)}`;
    expect(parseStellarAddress(g)).toEqual({ ok: true, value: g });
    expect(parseStellarAddress(c)).toEqual({ ok: true, value: c });
  });

  it.each([
    '',
    `G${'A'.repeat(54)}`,
    `S${'A'.repeat(55)}`,
    `G${'a'.repeat(55)}`,
    `G${'1'.repeat(55)}`,
  ])('rejects %j', (input) => {
    expect(parseStellarAddress(input)).toEqual({ ok: false, error: 'invalid_address' });
  });
});
