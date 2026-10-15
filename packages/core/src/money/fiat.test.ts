import { describe, expect, it } from 'vitest';
import { fiatAmount, minorUnitExponent, parseCurrency, type CurrencyCode } from './fiat.js';

describe('fiat', () => {
  it('accepts supported ISO 4217 codes', () => {
    expect(parseCurrency('GHS')).toEqual({ ok: true, value: 'GHS' });
  });

  it.each(['ghs', 'XXX', '', 'toString', '__proto__'])('rejects %j', (code) => {
    expect(parseCurrency(code)).toEqual({ ok: false, error: 'unsupported_currency' });
  });

  it('knows minor-unit exponents', () => {
    expect(minorUnitExponent('USD' as CurrencyCode)).toBe(2);
    expect(minorUnitExponent('XOF' as CurrencyCode)).toBe(0);
    expect(() => minorUnitExponent('XXX' as CurrencyCode)).toThrow();
  });

  it('builds positive amounts only', () => {
    expect(fiatAmount('USD', 1999n)).toEqual({
      ok: true,
      value: { currency: 'USD', minor: 1999n },
    });
    expect(fiatAmount('USD', 0n)).toEqual({ ok: false, error: 'invalid_fiat_amount' });
    expect(fiatAmount('XXX', 1n)).toEqual({ ok: false, error: 'unsupported_currency' });
  });
});
