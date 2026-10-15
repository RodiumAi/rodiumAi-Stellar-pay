import { createHmac } from 'node:crypto';
import { err, ok, type Result } from '@rp/core/result';
import { constantTimeEqual, decodeBase64Url, sha256 } from './encoding.js';

export const MAX_CLOCK_SKEW_SECONDS = 300;
/** Nonces are remembered for longer than the skew window in both directions. */
export const NONCE_TTL_SECONDS = 600;

export interface SignedRequest {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: Uint8Array;
}

export interface ApiKey {
  readonly id: string;
  readonly secret: Uint8Array;
  readonly status: 'active' | 'revoked';
}

export interface HmacDeps {
  readonly findKey: (keyId: string) => ApiKey | undefined;
  /** Atomically records the nonce; false if it was already seen. Must fail closed (throw) if the store is down. */
  readonly claimNonce: (keyId: string, nonce: string, ttlSeconds: number) => Promise<boolean>;
  readonly nowSeconds: () => number;
}

export interface HmacHeaders {
  readonly keyId: string | undefined;
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly signature: string | undefined;
}

export type HmacError =
  | 'missing_auth_header'
  | 'invalid_timestamp'
  | 'clock_skew'
  | 'invalid_nonce'
  | 'unknown_key'
  | 'revoked_key'
  | 'bad_signature'
  | 'replayed_nonce';

const TIMESTAMP = /^[1-9][0-9]{0,11}$/;
const MIN_NONCE_BYTES = 16;

export function canonicalString(req: SignedRequest): string {
  return [
    req.method.toUpperCase(),
    req.pathWithQuery,
    req.timestamp,
    req.nonce,
    sha256(req.body).toString('hex'),
  ].join('\n');
}

export function signRequest(secret: Uint8Array, req: SignedRequest): string {
  return createHmac('sha256', secret).update(canonicalString(req)).digest('base64url');
}

/**
 * Verifies context §9.1 request signing. The nonce is claimed only after the
 * signature checks out, so unauthenticated traffic cannot fill the nonce store.
 */
export async function verifyRequest(
  deps: HmacDeps,
  headers: HmacHeaders,
  req: Omit<SignedRequest, 'timestamp' | 'nonce'>,
): Promise<Result<{ readonly keyId: string }, HmacError>> {
  const { keyId, timestamp, nonce, signature } = headers;
  if (
    keyId === undefined ||
    timestamp === undefined ||
    nonce === undefined ||
    signature === undefined
  ) {
    return err('missing_auth_header');
  }
  if (!TIMESTAMP.test(timestamp)) {
    return err('invalid_timestamp');
  }
  if (Math.abs(deps.nowSeconds() - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return err('clock_skew');
  }
  const nonceBytes = decodeBase64Url(nonce);
  if (nonceBytes === null || nonceBytes.length < MIN_NONCE_BYTES) {
    return err('invalid_nonce');
  }
  const key = deps.findKey(keyId);
  if (key === undefined) {
    return err('unknown_key');
  }
  if (key.status === 'revoked') {
    return err('revoked_key');
  }
  const given = decodeBase64Url(signature);
  const expected = Buffer.from(signRequest(key.secret, { ...req, timestamp, nonce }), 'base64url');
  if (given === null || !constantTimeEqual(given, expected)) {
    return err('bad_signature');
  }
  if (!(await deps.claimNonce(keyId, nonce, NONCE_TTL_SECONDS))) {
    return err('replayed_nonce');
  }
  return ok({ keyId });
}
