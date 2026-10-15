import { sign, verify, type KeyObject } from 'node:crypto';
import { err, ok, type Result } from '@rp/core/result';
import { decodeBase64Url } from './encoding.js';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerifyError =
  'malformed_signature_header' | 'unknown_key' | 'stale_timestamp' | 'bad_signature';

function signedPayload(t: string, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${t}.`, 'utf8'), rawBody]);
}

/** Builds the `RP-Signature` header value (context §10.3). */
export function signWebhook(
  privateKey: KeyObject,
  keyId: string,
  timestampSeconds: number,
  rawBody: Uint8Array,
): string {
  const t = String(timestampSeconds);
  const s = sign(null, signedPayload(t, rawBody), privateKey).toString('base64url');
  return `t=${t},k=${keyId},s=${s}`;
}

const HEADER = /^t=([1-9][0-9]{0,11}),k=([A-Za-z0-9_-]{1,64}),s=([A-Za-z0-9_-]{86})$/;

/**
 * Reference verifier for the main app: verify the raw body bytes before parsing
 * JSON, reject old or future timestamps, then deduplicate on the event `id`.
 */
export function verifyWebhook(
  findPublicKey: (keyId: string) => KeyObject | undefined,
  header: string,
  rawBody: Uint8Array,
  nowSeconds: number,
): Result<{ readonly keyId: string; readonly timestamp: number }, WebhookVerifyError> {
  const match = HEADER.exec(header);
  const [, t, keyId, s] = match ?? [];
  if (t === undefined || keyId === undefined || s === undefined) {
    return err('malformed_signature_header');
  }
  const publicKey = findPublicKey(keyId);
  if (publicKey === undefined) {
    return err('unknown_key');
  }
  const timestamp = Number(t);
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return err('stale_timestamp');
  }
  const signature = decodeBase64Url(s);
  if (signature === null || !verify(null, signedPayload(t, rawBody), publicKey, signature)) {
    return err('bad_signature');
  }
  return ok({ keyId, timestamp });
}
