import type { Kms } from './kms.js';

/**
 * The two AWS KMS calls the adapter needs. `KMS` from `@aws-sdk/client-kms` matches it,
 * so this package stays free of the AWS SDK and tests can use a fake.
 */
export interface AwsKmsApi {
  encrypt(input: {
    KeyId: string;
    Plaintext: Uint8Array;
    EncryptionContext: Record<string, string>;
  }): Promise<{ CiphertextBlob?: Uint8Array | undefined }>;
  decrypt(input: {
    KeyId: string;
    CiphertextBlob: Uint8Array;
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array | undefined }>;
}

/** Binds every wrapped key to its purpose; KMS refuses to decrypt without the same context. */
const CONTEXT = { purpose: 'rp.field-data-key.v1' };

/**
 * Production KMS (context §12.2): data keys are wrapped by an AWS KMS symmetric key that
 * never leaves KMS. Decrypt pins `KeyId`, so a blob wrapped under another key is refused
 * even if this role could use that key.
 */
export function createAwsKms(api: AwsKmsApi, keyId: string): Kms {
  if (keyId.trim() === '') throw new Error('AWS KMS key id is required');
  return {
    async wrapKey(plaintext) {
      const out = await api.encrypt({
        KeyId: keyId,
        Plaintext: plaintext,
        EncryptionContext: CONTEXT,
      });
      if (out.CiphertextBlob === undefined) throw new Error('AWS KMS returned no ciphertext');
      return out.CiphertextBlob;
    },
    async unwrapKey(wrapped) {
      const out = await api.decrypt({
        KeyId: keyId,
        CiphertextBlob: wrapped,
        EncryptionContext: CONTEXT,
      });
      if (out.Plaintext === undefined) throw new Error('AWS KMS returned no plaintext');
      return out.Plaintext;
    },
  };
}
