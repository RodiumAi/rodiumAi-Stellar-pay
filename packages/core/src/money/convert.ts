import { err, type Result } from '../result.js';
import { minorUnitExponent, type FiatAmount } from './fiat.js';
import { FX_RATE_SCALE, type FxRate } from './fx-rate.js';
import { stroops, type Stroops } from './stroops.js';

const STROOPS_PER_CENT = 100_000n;
const CENTS_PER_UNIT = 100n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Converts a fiat amount to USDC, rounding UP to the nearest 0.01 USDC so the
 * merchant is never short (context §5 Money).
 */
export function fiatToStroops(
  amount: FiatAmount,
  rate: FxRate,
): Result<Stroops, 'amount_out_of_range'> {
  if (amount.minor <= 0n || rate <= 0n) {
    return err('amount_out_of_range');
  }
  const fiatScale = 10n ** BigInt(minorUnitExponent(amount.currency));
  const cents = ceilDiv(amount.minor * CENTS_PER_UNIT * FX_RATE_SCALE, fiatScale * rate);
  return stroops(cents * STROOPS_PER_CENT);
}
