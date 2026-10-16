// Creates a field-encryption data key wrapped by AWS KMS (context §12.2) and prints the
// FIELD_DATA_KEYS entry to append. Only the wrapped key is printed: the plaintext key never
// leaves this process. Uses the standard AWS credential chain; AWS_ENDPOINT_URL points it
// at a local emulator for testing.
//   AWS_REGION=eu-west-1 AWS_KMS_KEY_ID=alias/rp-field-kek node apps/api/scripts/aws-data-key.mjs
import { randomBytes } from 'node:crypto';
import { KMS } from '@aws-sdk/client-kms';
import { createAwsKms } from '@rp/security/aws-kms';
import { createDataKey } from '@rp/security/envelope';

const keyId = process.env.AWS_KMS_KEY_ID;
if (!keyId) throw new Error('AWS_KMS_KEY_ID must be set');
const kms = createAwsKms(new KMS({ maxAttempts: 3 }), keyId);
const { dataKey, stored } = await createDataKey(kms, randomBytes);
// Round trip before printing, so a key that cannot be unwrapped is never deployed.
const back = Buffer.from(await kms.unwrapKey(stored.wrapped));
if (!back.equals(dataKey.key)) throw new Error('unwrap returned a different key');
const id = Buffer.from(stored.id).toString('hex');
console.log(`data key ${id} wrapped by ${keyId} (round trip ok)`);
console.log(
  `append to FIELD_DATA_KEYS: ${id}:${Buffer.from(stored.wrapped).toString('base64url')}`,
);
console.log(`set FIELD_DATA_KEY_CURRENT=${id} once every instance has the new FIELD_DATA_KEYS`);
