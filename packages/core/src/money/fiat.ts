import type { Brand } from '../brand.js';
import { err, ok, type Result } from '../result.js';

export type CurrencyCode = Brand<string, 'CurrencyCode'>;

// ISO 4217 minor-unit exponents for the currencies this service may price in.
// Add a currency here before it can be accepted anywhere.
const MINOR_UNIT_EXPONENTS: ReadonlyMap<string, number> = new Map([
  ['USD', 2],
  ['EUR', 2],
  ['GBP', 2],
  ['GHS', 2],
  ['NGN', 2],
  ['KES', 2],
  ['ZAR', 2],
  ['XOF', 0],
]);

export interface FiatAmount {
  readonly currency: CurrencyCode;
  /** Amount in the currency's minor unit (e.g. cents). */
  readonly minor: bigint;
}

export type FiatError = 'unsupported_currency' | 'invalid_fiat_amount';

export function parseCurrency(code: string): Result<CurrencyCode, 'unsupported_currency'> {
  return MINOR_UNIT_EXPONENTS.has(code) ? ok(code as CurrencyCode) : err('unsupported_currency');
}

export function minorUnitExponent(currency: CurrencyCode): number {
  const exponent = MINOR_UNIT_EXPONENTS.get(currency);
  if (exponent === undefined) {
    throw new Error(`Currency ${currency} has no minor-unit exponent`);
  }
  return exponent;
}

export function fiatAmount(currency: string, minor: bigint): Result<FiatAmount, FiatError> {
  const parsed = parseCurrency(currency);
  if (!parsed.ok) {
    return parsed;
  }
  if (minor <= 0n) {
    return err('invalid_fiat_amount');
  }
  return ok({ currency: parsed.value, minor });
}
