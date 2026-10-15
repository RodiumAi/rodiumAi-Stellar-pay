import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fiatToStroops } from './convert.js';
import { minorUnitExponent, type CurrencyCode, type FiatAmount } from './fiat.js';
import { FX_RATE_SCALE, parseFxRate, USD_RATE, type FxRate } from './fx-rate.js';

const usd = (minor: bigint): FiatAmount => ({ currency: 'USD' as CurrencyCode, minor });

function rate(input: string): FxRate {
  const parsed = parseFxRate(input);
  if (!parsed.ok) throw new Error(input);
  return parsed.value;
}

describe('fiatToStroops', () => {
  it('converts USD 1:1', () => {
    expect(fiatToStroops(usd(1999n), USD_RATE)).toEqual({ ok: true, value: 199_900_000n });
  });

  it('rounds GHS up to the next cent of USDC', () => {
    // 100.00 GHS / 11.686603 = 8.5568... USDC -> 8.56
    const ghs = { currency: 'GHS' as CurrencyCode, minor: 10_000n };
    expect(fiatToStroops(ghs, rate('11.686603'))).toEqual({ ok: true, value: 85_600_000n });
  });

  it('handles zero-decimal currencies', () => {
    const xof = { currency: 'XOF' as CurrencyCode, minor: 600n };
    expect(fiatToStroops(xof, rate('600'))).toEqual({ ok: true, value: 10_000_000n });
  });

  it('never rounds down and never over-rounds by a cent or more', () => {
    const currency = fc.constantFrom('USD', 'GHS', 'XOF').map((c) => c as CurrencyCode);
    fc.assert(
      fc.property(
        currency,
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 10n ** 12n, max: 10n ** 22n }),
        (code, minor, scaledRate) => {
          const result = fiatToStroops({ currency: code, minor }, scaledRate as FxRate);
          if (!result.ok) return;
          const fiatScale = 10n ** BigInt(minorUnitExponent(code));
          // Compare result/1e7 with exact minor / fiatScale / (rate / 1e18) by cross-multiplying.
          const lhs = result.value * fiatScale * scaledRate;
          const exact = minor * 10_000_000n * FX_RATE_SCALE;
          const oneCent = 100_000n * fiatScale * scaledRate;
          expect(lhs >= exact).toBe(true);
          expect(lhs - exact < oneCent).toBe(true);
          expect(result.value % 100_000n).toBe(0n);
        },
      ),
    );
  });

  it('rejects non-positive input and overflow', () => {
    expect(fiatToStroops(usd(0n), USD_RATE).ok).toBe(false);
    expect(fiatToStroops(usd(1n), 0n as FxRate).ok).toBe(false);
    expect(fiatToStroops(usd(10n ** 18n), 1n as FxRate)).toEqual({
      ok: false,
      error: 'amount_out_of_range',
    });
  });
});
