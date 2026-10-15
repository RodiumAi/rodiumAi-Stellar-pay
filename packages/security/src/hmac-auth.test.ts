import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalString,
  signRequest,
  verifyRequest,
  type ApiKey,
  type HmacDeps,
} from './hmac-auth.js';

const NOW = 1_760_438_400;
const active: ApiKey = { id: 'ak_2026_10', secret: randomBytes(32), status: 'active' };
const next: ApiKey = { id: 'ak_2027_01', secret: randomBytes(32), status: 'active' };
const revoked: ApiKey = { id: 'ak_2026_07', secret: randomBytes(32), status: 'revoked' };

function deps(now = NOW): HmacDeps & { seen: Set<string> } {
  const seen = new Set<string>();
  const keys = new Map([active, next, revoked].map((k) => [k.id, k]));
  return {
    seen,
    findKey: (id) => keys.get(id),
    claimNonce: (keyId, nonce) => {
      const k = `${keyId}:${nonce}`;
      if (seen.has(k)) return Promise.resolve(false);
      seen.add(k);
      return Promise.resolve(true);
    },
    nowSeconds: () => now,
  };
}

const body = Buffer.from('{"amount":{"currency":"USD","value_minor":1999}}');
const base = { method: 'POST', pathWithQuery: '/v1/payments?x=1', body };

function signed(
  key: ApiKey = active,
  overrides: Partial<{ timestamp: string; nonce: string }> = {},
) {
  const timestamp = overrides.timestamp ?? String(NOW);
  const nonce = overrides.nonce ?? randomBytes(16).toString('base64url');
  return {
    keyId: key.id,
    timestamp,
    nonce,
    signature: signRequest(key.secret, { ...base, timestamp, nonce }),
  };
}

describe('HMAC request signing (context §9.1)', () => {
  it('builds the canonical string', () => {
    expect(
      canonicalString({
        ...base,
        method: 'post',
        timestamp: '1',
        nonce: 'n',
        body: Buffer.from(''),
      }),
    ).toBe(
      'POST\n/v1/payments?x=1\n1\nn\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('accepts a valid request', async () => {
    expect(await verifyRequest(deps(), signed(), base)).toEqual({
      ok: true,
      value: { keyId: active.id },
    });
  });

  it('accepts either of two active keys (rotation)', async () => {
    expect((await verifyRequest(deps(), signed(next), base)).ok).toBe(true);
  });

  it('accepts skew of exactly 300s', async () => {
    expect((await verifyRequest(deps(NOW + 300), signed(), base)).ok).toBe(true);
  });

  it('rejects a replayed nonce', async () => {
    const d = deps();
    const headers = signed();
    expect((await verifyRequest(d, headers, base)).ok).toBe(true);
    expect(await verifyRequest(d, headers, base)).toEqual({ ok: false, error: 'replayed_nonce' });
  });

  it.each([
    ['past', NOW + 301],
    ['future', NOW - 301],
  ])('rejects %s skew over 300s', async (_d, now) => {
    expect(await verifyRequest(deps(now), signed(), base)).toEqual({
      ok: false,
      error: 'clock_skew',
    });
  });

  it('rejects unknown and revoked keys', async () => {
    const unknown = { ...signed(), keyId: 'ak_nope' };
    expect(await verifyRequest(deps(), unknown, base)).toEqual({ ok: false, error: 'unknown_key' });
    expect(await verifyRequest(deps(), signed(revoked), base)).toEqual({
      ok: false,
      error: 'revoked_key',
    });
  });

  it.each([
    ['body', { ...base, body: Buffer.from('{"amount":{"currency":"USD","value_minor":1}}') }],
    ['path', { ...base, pathWithQuery: '/v1/payments?x=2' }],
    ['method', { ...base, method: 'GET' }],
  ])('rejects a tampered %s', async (_name, req) => {
    expect(await verifyRequest(deps(), signed(), req)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('rejects a signature made with another key', async () => {
    const forged = { ...signed(next), keyId: active.id };
    expect(await verifyRequest(deps(), forged, base)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('does not burn the nonce on a bad signature', async () => {
    const d = deps();
    const headers = signed();
    await verifyRequest(d, { ...headers, signature: 'A'.repeat(43) }, base);
    expect(d.seen.size).toBe(0);
    expect((await verifyRequest(d, headers, base)).ok).toBe(true);
  });

  it.each([
    [{ keyId: undefined }, 'missing_auth_header'],
    [{ timestamp: undefined }, 'missing_auth_header'],
    [{ nonce: undefined }, 'missing_auth_header'],
    [{ signature: undefined }, 'missing_auth_header'],
    [{ timestamp: '1.5e9' }, 'invalid_timestamp'],
    [{ timestamp: '-1' }, 'invalid_timestamp'],
    [{ nonce: 'short' }, 'invalid_nonce'],
    [{ nonce: 'not base64url!!!!!!!!!!!!' }, 'invalid_nonce'],
    [{ signature: 'not+base64url/' }, 'bad_signature'],
  ])('rejects malformed headers %o', async (override, error) => {
    expect(await verifyRequest(deps(), { ...signed(), ...override }, base)).toEqual({
      ok: false,
      error,
    });
  });

  it('fails closed when the nonce store is down', async () => {
    const d = { ...deps(), claimNonce: () => Promise.reject(new Error('upstash down')) };
    await expect(verifyRequest(d, signed(), base)).rejects.toThrow('upstash down');
  });
});
