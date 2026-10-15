import type { RandomBytes } from '@rp/core/random';
import { decodeBase64Url, sha256 } from './encoding.js';

const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Sent to the user once; never stored. */
  readonly token: string;
  /** Stored and used for lookup. */
  readonly hash: Buffer;
}

/** Checkout token: 32 random bytes, base64url; only its SHA-256 is stored (context §11.2). */
export function issueCheckoutToken(randomBytes: RandomBytes): IssuedToken {
  const token = Buffer.from(randomBytes(TOKEN_BYTES)).toString('base64url');
  return { token, hash: sha256(token) };
}

/** Hash for lookup, or null when the input cannot be a token we issued. */
export function hashCheckoutToken(token: string): Buffer | null {
  return decodeBase64Url(token)?.length === TOKEN_BYTES ? sha256(token) : null;
}
