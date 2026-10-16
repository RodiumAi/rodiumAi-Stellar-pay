// Signed request to a running API (context §9.1) — the reference for how the main app
// must call it. Usage: pnpm api:call POST /v1/payments '{"..."}'  |  pnpm api:call GET /v1/payments/<id>
// Reads API_HMAC_KEYS (first key) and PORT from .env; prints status and body only.
import { randomBytes } from 'node:crypto';
import { signRequest } from '@rp/security/hmac-auth';

const [method = 'GET', path = '/v1/health/ready', bodyText] = process.argv.slice(2);
const [keyId, secretB64] = (process.env.API_HMAC_KEYS ?? '').split(',')[0].split(':');
const body = Buffer.from(bodyText ?? '', 'utf8');
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(16).toString('base64url');
const signature = signRequest(Buffer.from(secretB64, 'base64url'), {
  method,
  pathWithQuery: path,
  timestamp,
  nonce,
  body,
});

const res = await fetch(`http://localhost:${process.env.PORT ?? '8080'}${path}`, {
  method,
  headers: {
    'x-rp-key-id': keyId,
    'x-rp-timestamp': timestamp,
    'x-rp-nonce': nonce,
    'x-rp-signature': signature,
    ...(method === 'POST'
      ? {
          'content-type': 'application/json',
          'idempotency-key': process.env.IDEMPOTENCY_KEY ?? `cli_${randomBytes(8).toString('hex')}`,
        }
      : {}),
  },
  ...(method === 'POST' ? { body } : {}),
});
console.log(res.status, await res.text());
