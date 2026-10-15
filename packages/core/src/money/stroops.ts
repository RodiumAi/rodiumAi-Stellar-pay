import type { Brand } from '../brand.js';
import { err, ok, type Result } from '../result.js';
import { splitDecimal } from './decimal.js';

/** 1 USDC = 10,000,000 stroops. Always a non-negative bigint that fits Postgres `bigint`. */
export type Stroops = Brand<bigint, 'Stroops'>;

export const STROOPS_PER_UNIT = 10_000_000n;
export const MAX_STROOPS = 9_223_372_036_854_775_807n;
const DECIMALS = 7;

export type AmountError = 'invalid_amount_format' | 'amount_out_of_range';

export function stroops(value: bigint): Result<Stroops, 'amount_out_of_range'> {
  if (value < 0n || value > MAX_STROOPS) {
    return err('amount_out_of_range');
  }
  return ok(value as Stroops);
}

export function parseAmount(input: string): Result<Stroops, AmountError> {
  const parts = splitDecimal(input, DECIMALS);
  if (parts === null) {
    return err('invalid_amount_format');
  }
  return stroops(BigInt(parts.whole) * STROOPS_PER_UNIT + BigInt(parts.fraction));
}

export function formatAmount(amount: Stroops): string {
  const whole = amount / STROOPS_PER_UNIT;
  const fraction = (amount % STROOPS_PER_UNIT).toString().padStart(DECIMALS, '0');
  return `${whole.toString()}.${fraction}`;
}

export function addStroops(a: Stroops, b: Stroops): Result<Stroops, 'amount_out_of_range'> {
  return stroops(a + b);
}
