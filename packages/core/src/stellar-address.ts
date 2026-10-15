import type { Brand } from './brand.js';
import { err, ok, type Result } from './result.js';

/**
 * A Stellar account (G...) or contract (C...) strkey. This only checks shape;
 * `packages/stellar` verifies the checksum with the SDK at the boundary.
 */
export type StellarAddress = Brand<string, 'StellarAddress'>;

const STRKEY_PATTERN = /^[GC][A-Z2-7]{55}$/;

export function parseStellarAddress(value: string): Result<StellarAddress, 'invalid_address'> {
  return STRKEY_PATTERN.test(value) ? ok(value as StellarAddress) : err('invalid_address');
}
