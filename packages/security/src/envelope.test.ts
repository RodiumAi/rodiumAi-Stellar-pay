import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDataKey,
  decryptField,
  encryptField,
  loadKeyring,
  needsReencryption,
  type FieldLocation,
} from './envelope.js';
import { createLocalDevKms } from './kms.js';

const kms = createLocalDevKms(randomBytes(32), randomBytes);
const loc: FieldLocation = {
  table: 'payments',
  column: 'customer_ref_enc',
  rowId: '0199e5c2-0000-7000-8000-000000000001',
};
const plaintext = Buffer.from('customer-42@example.com');

async function keyrings() {
  const a = await createDataKey(kms, randomBytes);
  const b = await createDataKey(kms, randomBytes);
  return {
    old: await loadKeyring(kms, [a.stored], a.stored.id),
    rotated: await loadKeyring(kms, [a.stored, b.stored], b.stored.id),
  };
}

describe('envelope encryption (context §12.2)', () => {
  it('round-trips with the stored layout', async () => {
    const { old } = await keyrings();
    const blob = encryptField(old, plaintext, loc, randomBytes);
    expect(blob[0]).toBe(1);
    expect(blob.subarray(1, 17).equals(old.current.id)).toBe(true);
    expect(blob.length).toBe(1 + 16 + 12 + plaintext.length + 16);
    expect(decryptField(old, blob, loc)).toEqual({ ok: true, value: plaintext });
  });

  it('uses a fresh nonce each time', async () => {
    const { old } = await keyrings();
    expect(
      encryptField(old, plaintext, loc, randomBytes).equals(
        encryptField(old, plaintext, loc, randomBytes),
      ),
    ).toBe(false);
  });

  it.each([
    ['row', { ...loc, rowId: '0199e5c2-0000-7000-8000-000000000002' }],
    ['column', { ...loc, column: 'description' }],
    ['table', { ...loc, table: 'subscriptions' }],
  ])('refuses a ciphertext moved to another %s (AAD)', async (_name, moved) => {
    const { old } = await keyrings();
    const blob = encryptField(old, plaintext, loc, randomBytes);
    expect(decryptField(old, blob, moved)).toEqual({ ok: false, error: 'decryption_failed' });
  });

  it('refuses a tampered tag or ciphertext', async () => {
    const { old } = await keyrings();
    const blob = encryptField(old, plaintext, loc, randomBytes);
    const tag = Buffer.from(blob);
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 1;
    const ct = Buffer.from(blob);
    ct[30] = (ct[30] ?? 0) ^ 1;
    expect(decryptField(old, tag, loc)).toEqual({ ok: false, error: 'decryption_failed' });
    expect(decryptField(old, ct, loc)).toEqual({ ok: false, error: 'decryption_failed' });
  });

  it('reads old-key values after rotation and flags them for re-encryption', async () => {
    const { old, rotated } = await keyrings();
    const oldBlob = encryptField(old, plaintext, loc, randomBytes);
    expect(decryptField(rotated, oldBlob, loc)).toEqual({ ok: true, value: plaintext });
    expect(needsReencryption(rotated, oldBlob)).toBe(true);
    expect(needsReencryption(rotated, encryptField(rotated, plaintext, loc, randomBytes))).toBe(
      false,
    );
  });

  it('rejects unknown keys and malformed blobs', async () => {
    const { old } = await keyrings();
    const other = await keyrings();
    expect(decryptField(old, encryptField(other.old, plaintext, loc, randomBytes), loc)).toEqual({
      ok: false,
      error: 'unknown_key',
    });
    expect(decryptField(old, Buffer.alloc(10), loc)).toEqual({
      ok: false,
      error: 'malformed_ciphertext',
    });
    const badVersion = encryptField(old, plaintext, loc, randomBytes);
    badVersion[0] = 2;
    expect(decryptField(old, badVersion, loc)).toEqual({
      ok: false,
      error: 'malformed_ciphertext',
    });
  });

  it('refuses to load a keyring without the current key or with a bad wrapped key', async () => {
    const a = await createDataKey(kms, randomBytes);
    await expect(loadKeyring(kms, [a.stored], randomBytes(16))).rejects.toThrow('Current data key');
    const otherKms = createLocalDevKms(randomBytes(32), randomBytes);
    await expect(loadKeyring(otherKms, [a.stored], a.stored.id)).rejects.toThrow();
    const short = { id: randomBytes(8), wrapped: await kms.wrapKey(randomBytes(32)) };
    await expect(loadKeyring(kms, [short], short.id)).rejects.toThrow('wrong size');
  });

  it('local dev KMS requires a 32-byte master key', () => {
    expect(() => createLocalDevKms(randomBytes(16), randomBytes)).toThrow();
  });

  it('local dev KMS rejects truncated wrapped keys and truncated tags', async () => {
    const wrapped = Buffer.from(await kms.wrapKey(randomBytes(32)));
    await expect(kms.unwrapKey(wrapped.subarray(0, 28))).rejects.toThrow('too short');
    await expect(kms.unwrapKey(wrapped.subarray(0, wrapped.length - 4))).rejects.toThrow();
  });

  it('rejects a ciphertext with its tag truncated', async () => {
    const { old } = await keyrings();
    const blob = encryptField(old, plaintext, loc, randomBytes);
    expect(decryptField(old, blob.subarray(0, blob.length - 4), loc)).toEqual({
      ok: false,
      error: 'decryption_failed',
    });
  });
});
