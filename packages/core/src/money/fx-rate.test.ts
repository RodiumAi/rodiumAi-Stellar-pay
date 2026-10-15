import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatFxRate, FX_RATE_SCALE, parseFxRate, USD_RATE, type FxRate } from './fx-rate.js';

describe('parseFxRate', () => {
  it('parses provider rates into 18-decimal fixed point', () => {
    expect(parseFxRate('11.686603')).toEqual({ ok: true, value: 11_686_603_000_000_000_000n });
    expect(parseFxRate('1')).toEqual({ ok: true, value: USD_RATE });
  });

  it('round-trips through formatFxRate', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 38n - 1n }), (scaled) => {
        expect(parseFxRate(formatFxRate(scaled as FxRate))).toEqual({ ok: true, value: scaled });
      }),
    );
  });

  it.each(['0', '0.0', '-1', '1e3', '', '1.0000000000000000001', '123456789012345678901', ' 1'])(
    'rejects %j',
    (input) => {
      expect(parseFxRate(input)).toEqual({ ok: false, error: 'invalid_fx_rate' });
    },
  );

  it('uses an 18-decimal scale', () => {
    expect(FX_RATE_SCALE).toBe(10n ** 18n);
  });
});
