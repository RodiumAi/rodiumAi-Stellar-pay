import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAwsKms, type AwsKmsApi } from './aws-kms.js';
import { createDataKey, decryptField, encryptField, loadKeyring } from './envelope.js';

/** Fake KMS: AES-GCM per key id, authenticating the key id and encryption context like AWS. */
function fakeKms(): AwsKmsApi & { calls: string[] } {
  const keys = new Map([
    ['alias/rp-field', randomBytes(32)],
    ['alias/other', randomBytes(32)],
  ]);
  const aad = (keyId: string, ctx: Record<string, string>) =>
    Buffer.from(JSON.stringify([keyId, ctx]));
  const calls: string[] = [];
  return {
    calls,
    encrypt({ KeyId, Plaintext, EncryptionContext }) {
      calls.push(`encrypt:${KeyId}`);
      const key = keys.get(KeyId);
      if (key === undefined) return Promise.reject(new Error('NotFoundException'));
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }).setAAD(
        aad(KeyId, EncryptionContext),
      );
      const ct = Buffer.concat([c.update(Plaintext), c.final()]);
      return Promise.resolve({ CiphertextBlob: Buffer.concat([nonce, ct, c.getAuthTag()]) });
    },
    decrypt({ KeyId, CiphertextBlob, EncryptionContext }) {
      calls.push(`decrypt:${KeyId}`);
      const key = keys.get(KeyId);
      if (key === undefined) return Promise.reject(new Error('NotFoundException'));
      const buf = Buffer.from(CiphertextBlob);
      try {
        const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12), {
          authTagLength: 16,
        }).setAAD(aad(KeyId, EncryptionContext));
        d.setAuthTag(buf.subarray(buf.length - 16));
        const pt = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
        return Promise.resolve({ Plaintext: pt });
      } catch {
        return Promise.reject(new Error('InvalidCiphertextException'));
      }
    },
  };
}

const loc = { table: 'payments', column: 'customer_ref_enc', rowId: 'row-1' };

describe('AWS KMS adapter (context §12.2)', () => {
  it('wraps and unwraps data keys used by envelope encryption', async () => {
    const api = fakeKms();
    const kms = createAwsKms(api, 'alias/rp-field');
    const { stored } = await createDataKey(kms, randomBytes);
    const keyring = await loadKeyring(kms, [stored], stored.id);
    const ct = encryptField(keyring, Buffer.from('usr_42'), loc, randomBytes);
    const pt = decryptField(keyring, ct, loc);
    expect(pt.ok && pt.value.toString()).toBe('usr_42');
    expect(api.calls).toEqual(['encrypt:alias/rp-field', 'decrypt:alias/rp-field']);
  });

  it('refuses a key wrapped under another KMS key', async () => {
    const api = fakeKms();
    const wrapped = await createAwsKms(api, 'alias/other').wrapKey(randomBytes(32));
    await expect(createAwsKms(api, 'alias/rp-field').unwrapKey(wrapped)).rejects.toThrow(
      'InvalidCiphertextException',
    );
  });

  it('refuses ciphertext made for another purpose (encryption context)', async () => {
    const api = fakeKms();
    const { CiphertextBlob } = await api.encrypt({
      KeyId: 'alias/rp-field',
      Plaintext: randomBytes(32),
      EncryptionContext: { purpose: 'something-else' },
    });
    await expect(
      createAwsKms(api, 'alias/rp-field').unwrapKey(CiphertextBlob ?? new Uint8Array()),
    ).rejects.toThrow('InvalidCiphertextException');
  });

  it('fails closed on empty responses and an empty key id', async () => {
    const empty: AwsKmsApi = {
      encrypt: () => Promise.resolve({}),
      decrypt: () => Promise.resolve({}),
    };
    const kms = createAwsKms(empty, 'alias/rp-field');
    await expect(kms.wrapKey(randomBytes(32))).rejects.toThrow('no ciphertext');
    await expect(kms.unwrapKey(randomBytes(64))).rejects.toThrow('no plaintext');
    expect(() => createAwsKms(empty, ' ')).toThrow('key id is required');
  });
});
