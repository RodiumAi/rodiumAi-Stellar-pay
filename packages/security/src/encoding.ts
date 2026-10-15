import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Constant-time comparison that also hides length differences. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Strict base64url decode: rejects padding, other alphabets and non-canonical input. */
export function decodeBase64Url(input: string): Buffer | null {
  if (!BASE64URL.test(input)) {
    return null;
  }
  const decoded = Buffer.from(input, 'base64url');
  return decoded.toString('base64url') === input ? decoded : null;
}
