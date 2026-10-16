// Adds the API's local-dev settings to .env without printing secrets: a checkout token
// key, a field-encryption data key wrapped by LOCAL_DEV_KMS_MASTER_KEY, and plain
// defaults for anything missing. Never overwrites a value that is already set.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createDataKey } from '@rp/security/envelope';
import { createLocalDevKms } from '@rp/security/kms';

process.chdir(new URL('../../../', import.meta.url).pathname);
process.loadEnvFile('.env');
const master = process.env.LOCAL_DEV_KMS_MASTER_KEY ?? '';
if (Buffer.from(master, 'base64url').length !== 32)
  throw new Error('LOCAL_DEV_KMS_MASTER_KEY must be set first');

const { stored } = await createDataKey(
  createLocalDevKms(Buffer.from(master, 'base64url'), randomBytes),
  randomBytes,
);
const dataKeyId = Buffer.from(stored.id).toString('hex');
const wanted = {
  PORT: '8080',
  CHECKOUT_BASE_URL: 'http://localhost:8081',
  RETURN_URL_ORIGINS: 'http://localhost:3000',
  PAYMENT_TTL_SECONDS: '1200',
  SUBSCRIPTION_PLANS:
    '[{"code":"pro_monthly","contractPlanId":1,"price":"9.99","intervalSeconds":2592000}]',
  CHECKOUT_TOKEN_KEY: randomBytes(32).toString('base64url'),
  FIELD_DATA_KEYS: `${dataKeyId}:${Buffer.from(stored.wrapped).toString('base64url')}`,
  FIELD_DATA_KEY_CURRENT: dataKeyId,
};

const lines = readFileSync('.env', 'utf8').split('\n');
const seen = new Set();
const filled = [];
const out = lines.map((line) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m || !(m[1] in wanted)) return line;
  seen.add(m[1]);
  if (m[2] !== '' && !m[2].includes('<')) return line;
  filled.push(m[1]);
  return `${m[1]}=${wanted[m[1]]}`;
});
const appended = Object.keys(wanted).filter((k) => !seen.has(k));
for (const k of appended) out.push(`${k}=${wanted[k]}`);
writeFileSync('.env', out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
console.log(
  `filled: ${filled.join(', ') || '(none)'}; appended: ${appended.join(', ') || '(none)'}`,
);
