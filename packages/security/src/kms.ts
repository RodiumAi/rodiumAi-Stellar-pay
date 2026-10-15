import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { RandomBytes } from '@rp/core/random';

/** Wraps data keys under a key-encryption key that never leaves the KMS (context §12.2). */
export interface Kms {
  wrapKey(plaintext: Uint8Array): Promise<Uint8Array>;
  unwrapKey(wrapped: Uint8Array): Promise<Uint8Array>;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAP_AAD = Buffer.from('rp.kms.local-dev.v1');

/**
 * Local development KMS: AES-256-GCM under an in-process master key.
 * Production uses the AWS KMS adapter (Sprint 10); never wire this in production.
 */
export function createLocalDevKms(masterKey: Uint8Array, randomBytes: RandomBytes): Kms {
  if (masterKey.length !== 32) {
    throw new Error('Local dev KMS master key must be 32 bytes');
  }
  return {
    wrapKey(plaintext) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', masterKey, nonce).setAAD(WRAP_AAD);
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Promise.resolve(Buffer.concat([nonce, ct, cipher.getAuthTag()]));
    },
    unwrapKey(wrapped) {
      const buf = Buffer.from(wrapped);
      const nonce = buf.subarray(0, NONCE_BYTES);
      const tag = buf.subarray(buf.length - TAG_BYTES);
      const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce).setAAD(WRAP_AAD);
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(ct), decipher.final()]));
    },
  };
}
