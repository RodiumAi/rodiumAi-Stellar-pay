import { describe, expect, it } from 'vitest';
import { resolveSecretFiles } from './secret-files.js';

const files = new Map(
  Object.entries({
    '/run/secrets/hmac': 'k1:abc\n',
    '/run/secrets/pem': '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n',
  }),
);
const read = (path: string): string => {
  const v = files.get(path);
  if (v === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return v;
};

describe('secret files (context §12.4)', () => {
  it('reads FOO_FILE into FOO and drops the _FILE key', () => {
    const r = resolveSecretFiles(
      {
        API_HMAC_KEYS_FILE: '/run/secrets/hmac',
        WEBHOOK_SIGNING_KEY_PEM_FILE: '/run/secrets/pem',
        PORT: '8080',
      },
      read,
    );
    expect(r).toEqual({
      ok: true,
      value: {
        API_HMAC_KEYS: 'k1:abc',
        WEBHOOK_SIGNING_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----',
        PORT: '8080',
      },
    });
  });

  it('refuses a secret set both directly and as a file', () => {
    const r = resolveSecretFiles(
      { API_HMAC_KEYS: 'k0:old', API_HMAC_KEYS_FILE: '/run/secrets/hmac' },
      read,
    );
    expect(r).toEqual({
      ok: false,
      error: ['API_HMAC_KEYS: set both directly and via API_HMAC_KEYS_FILE; use one'],
    });
  });

  it('reports a missing file by code only', () => {
    const r = resolveSecretFiles({ KEEPER_SECRET_FILE: '/run/secrets/nope' }, read);
    expect(r).toEqual({
      ok: false,
      error: ['KEEPER_SECRET_FILE: cannot read /run/secrets/nope (ENOENT)'],
    });
  });

  it('ignores empty _FILE values and leaves other keys alone', () => {
    expect(resolveSecretFiles({ X_FILE: '', Y: '1' }, read)).toEqual({
      ok: true,
      value: { X_FILE: '', Y: '1' },
    });
  });
});
