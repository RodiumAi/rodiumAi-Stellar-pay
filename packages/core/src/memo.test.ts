import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateMemo, normalizeMemo, parseMemo } from './memo.js';

const bytes8 = fc.uint8Array({ minLength: 8, maxLength: 8 });

describe('memo', () => {
  it('generates RP + 12 Crockford base32 characters within 28 bytes', () => {
    fc.assert(
      fc.property(bytes8, (b) => {
        const memo = generateMemo(() => b);
        expect(memo).toMatch(/^RP[0-9A-HJKMNP-TV-Z]{12}$/);
        expect(new TextEncoder().encode(memo).length).toBeLessThanOrEqual(28);
        expect(parseMemo(memo)).toEqual({ ok: true, value: memo });
      }),
    );
  });

  it('is deterministic for given bytes and differs for different bytes', () => {
    const zeros = generateMemo(() => new Uint8Array(8));
    expect(zeros).toBe('RP000000000000');
    expect(generateMemo(() => new Uint8Array(8).fill(255))).toBe('RPZZZZZZZZZZZZ');
  });

  it('rejects a random source returning the wrong length', () => {
    expect(() => generateMemo(() => new Uint8Array(4))).toThrow();
  });

  it('normalizes by trimming and upper-casing', () => {
    expect(normalizeMemo('  rp0123456789ab \n')).toBe('RP0123456789AB');
    expect(parseMemo(' rp0123456789ab')).toEqual({ ok: true, value: 'RP0123456789AB' });
  });

  it.each([
    '',
    'RP',
    'RP0123456789A',
    'RP0123456789ABC',
    'XX0123456789AB',
    'RP0123456789AI',
    'RP01234567 9AB',
  ])('rejects %j', (input) => {
    expect(parseMemo(input)).toEqual({ ok: false, error: 'invalid_memo' });
  });
});
