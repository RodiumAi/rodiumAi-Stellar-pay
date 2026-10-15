import type { Brand } from '../brand.js';
import { err, ok, type Result } from '../result.js';
import { splitDecimal } from './decimal.js';

/**
 * Units of fiat per 1 USDC, as a fixed-point bigint with 18 decimals
 * (matches the `numeric(38,18)` column `payments.fx_rate`).
 */
export type FxRate = Brand<bigint, 'FxRate'>;

export const FX_RATE_SCALE = 10n ** 18n;
export const USD_RATE = FX_RATE_SCALE as FxRate;

const MAX_WHOLE_DIGITS = 20;

export function parseFxRate(input: string): Result<FxRate, 'invalid_fx_rate'> {
  const parts = splitDecimal(input, 18);
  if (parts === null || parts.whole.length > MAX_WHOLE_DIGITS) {
    return err('invalid_fx_rate');
  }
  const scaled = BigInt(parts.whole) * FX_RATE_SCALE + BigInt(parts.fraction);
  return scaled > 0n ? ok(scaled as FxRate) : err('invalid_fx_rate');
}

export function formatFxRate(rate: FxRate): string {
  const whole = rate / FX_RATE_SCALE;
  const fraction = (rate % FX_RATE_SCALE).toString().padStart(18, '0');
  return `${whole.toString()}.${fraction}`;
}
