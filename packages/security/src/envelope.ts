import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { RandomBytes } from '@rp/core/random';
import { err, ok, type Result } from '@rp/core/result';
import type { Kms } from './kms.js';

const VERSION = 1;
const KEY_ID_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const HEADER_BYTES = 1 + KEY_ID_BYTES + NONCE_BYTES;

export interface DataKey {
  readonly id: Buffer;
  readonly key: Buffer;
}

/** A data key as persisted: its ID and the KMS-wrapped key bytes. */
export interface StoredDataKey {
  readonly id: Uint8Array;
  readonly wrapped: Uint8Array;
}

export interface Keyring {
  readonly current: DataKey;
  find(id: Uint8Array): DataKey | undefined;
}

/** Where a ciphertext lives; bound into the AAD so it cannot be moved to another row. */
export interface FieldLocation {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

export type DecryptError = 'malformed_ciphertext' | 'unknown_key' | 'decryption_failed';

export async function createDataKey(
  kms: Kms,
  randomBytes: RandomBytes,
): Promise<{ readonly dataKey: DataKey; readonly stored: StoredDataKey }> {
  const id = Buffer.from(randomBytes(KEY_ID_BYTES));
  const key = Buffer.from(randomBytes(DATA_KEY_BYTES));
  return { dataKey: { id, key }, stored: { id, wrapped: await kms.wrapKey(key) } };
}

export async function loadKeyring(
  kms: Kms,
  stored: readonly StoredDataKey[],
  currentId: Uint8Array,
): Promise<Keyring> {
  const keys = new Map<string, DataKey>();
  for (const s of stored) {
    const key = Buffer.from(await kms.unwrapKey(s.wrapped));
    if (s.id.length !== KEY_ID_BYTES || key.length !== DATA_KEY_BYTES) {
      throw new Error('Stored data key has the wrong size');
    }
    keys.set(Buffer.from(s.id).toString('hex'), { id: Buffer.from(s.id), key });
  }
  const current = keys.get(Buffer.from(currentId).toString('hex'));
  if (current === undefined) {
    throw new Error('Current data key is not in the keyring');
  }
  return { current, find: (id) => keys.get(Buffer.from(id).toString('hex')) };
}

function aad(location: FieldLocation): Buffer {
  return Buffer.from(`${location.table}.${location.column}.${location.rowId}`, 'utf8');
}

/** `version(1) || key_id(16) || nonce(12) || ciphertext || tag(16)` (context §12.2). */
export function encryptField(
  keyring: Keyring,
  plaintext: Uint8Array,
  location: FieldLocation,
  randomBytes: RandomBytes,
): Buffer {
  const { id, key } = keyring.current;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(aad(location));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), id, nonce, ct, cipher.getAuthTag()]);
}

export function decryptField(
  keyring: Keyring,
  blob: Uint8Array,
  location: FieldLocation,
): Result<Buffer, DecryptError> {
  const buf = Buffer.from(blob);
  if (buf.length < HEADER_BYTES + TAG_BYTES || buf[0] !== VERSION) {
    return err('malformed_ciphertext');
  }
  const dataKey = keyring.find(buf.subarray(1, 1 + KEY_ID_BYTES));
  if (dataKey === undefined) {
    return err('unknown_key');
  }
  const nonce = buf.subarray(1 + KEY_ID_BYTES, HEADER_BYTES);
  const ct = buf.subarray(HEADER_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', dataKey.key, nonce).setAAD(aad(location));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  try {
    return ok(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch {
    return err('decryption_failed');
  }
}

/** True when the value was written under an older key and the rotation job should re-encrypt it. */
export function needsReencryption(keyring: Keyring, blob: Uint8Array): boolean {
  return !Buffer.from(blob)
    .subarray(1, 1 + KEY_ID_BYTES)
    .equals(keyring.current.id);
}
