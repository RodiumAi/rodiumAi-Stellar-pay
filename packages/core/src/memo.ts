import type { Brand } from './brand.js';
import type { RandomBytes } from './random.js';
import { err, ok, type Result } from './result.js';

/** `RP` + 12 Crockford base32 characters (context §13.2). */
export type Memo = Brand<string, 'Memo'>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'RP';
const BODY_LENGTH = 12;
const MEMO_PATTERN = /^RP[0-9A-HJKMNP-TV-Z]{12}$/;

export function generateMemo(randomBytes: RandomBytes): Memo {
  const bytes = randomBytes(8);
  if (bytes.length !== 8) {
    throw new Error('randomBytes returned the wrong length');
  }
  // 12 characters x 5 bits = 60 bits, taken from 64 random bits.
  let bits = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i++) {
    body = (CROCKFORD[Number(bits & 31n)] ?? '') + body;
    bits >>= 5n;
  }
  return (PREFIX + body) as Memo;
}

export function normalizeMemo(input: string): string {
  return input.trim().toUpperCase();
}

export function parseMemo(input: string): Result<Memo, 'invalid_memo'> {
  const normalized = normalizeMemo(input);
  return MEMO_PATTERN.test(normalized) ? ok(normalized as Memo) : err('invalid_memo');
}
