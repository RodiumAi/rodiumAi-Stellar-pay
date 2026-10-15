import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addStroops,
  formatAmount,
  MAX_STROOPS,
  parseAmount,
  stroops,
  type Stroops,
} from './stroops.js';

const anyStroops = fc.bigInt({ min: 0n, max: MAX_STROOPS }).map((n) => n as Stroops);

describe('parseAmount / formatAmount', () => {
  it('round-trips every representable amount', () => {
    fc.assert(
      fc.property(anyStroops, (amount) => {
        expect(parseAmount(formatAmount(amount))).toEqual({ ok: true, value: amount });
      }),
    );
  });

  it('always formats exactly 7 decimals', () => {
    fc.assert(
      fc.property(anyStroops, (amount) => {
        expect(formatAmount(amount)).toMatch(/^\d+\.\d{7}$/);
      }),
    );
  });

  it.each([
    ['19.99', 199_900_000n],
    ['0.0000001', 1n],
    ['1', 10_000_000n],
    ['0', 0n],
    ['922337203685.4775807', MAX_STROOPS],
  ])('parses %s', (input, expected) => {
    expect(parseAmount(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    '0.00000001',
    '-1',
    '+1',
    '1e7',
    '1E-7',
    ' 1',
    '1 ',
    '1\n',
    '',
    '.5',
    '5.',
    '01',
    '1.2.3',
    '1,5',
    '０',
    'NaN',
    'Infinity',
    '0x10',
  ])('rejects %j', (input) => {
    expect(parseAmount(input)).toEqual({ ok: false, error: 'invalid_amount_format' });
  });

  it('rejects amounts above Postgres bigint', () => {
    expect(parseAmount('922337203685.4775808')).toEqual({
      ok: false,
      error: 'amount_out_of_range',
    });
  });
});

describe('stroops', () => {
  it('rejects negatives and overflow', () => {
    expect(stroops(-1n).ok).toBe(false);
    expect(stroops(MAX_STROOPS + 1n).ok).toBe(false);
  });

  it('adds with an overflow check', () => {
    expect(addStroops(1n as Stroops, 2n as Stroops)).toEqual({ ok: true, value: 3n });
    expect(addStroops(MAX_STROOPS as Stroops, 1n as Stroops).ok).toBe(false);
  });
});
