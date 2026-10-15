const DIGITS = /^[0-9]+$/;

export interface DecimalParts {
  readonly whole: string;
  /** Right-padded with zeros to exactly `maxDecimals` digits. */
  readonly fraction: string;
}

/**
 * Splits a plain decimal string ("12", "0.5", "19.99") into digit strings.
 * Rejects signs, exponents, whitespace, leading zeros, a bare "." edge and
 * more than `maxDecimals` fraction digits. Returns null on any violation.
 */
export function splitDecimal(input: string, maxDecimals: number): DecimalParts | null {
  const [whole = '', fraction, ...rest] = input.split('.');
  if (rest.length > 0 || !DIGITS.test(whole) || (whole.length > 1 && whole.startsWith('0'))) {
    return null;
  }
  if (fraction === undefined) {
    return { whole, fraction: '0'.repeat(maxDecimals) };
  }
  if (!DIGITS.test(fraction) || fraction.length > maxDecimals) {
    return null;
  }
  return { whole, fraction: fraction.padEnd(maxDecimals, '0') };
}
