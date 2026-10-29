import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAlbVerifier } from './alb-auth.js';

const ALB =
  'arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/test-alb/0123456789abcdef';
const NOW = 1_800_000_000;
const KID = '7a3b1c2d-0000-4000-8000-000000000001';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** AWS pads base64url with `=`; mimic that so the verifier is tested against real tokens. */
const b64 = (value: object): string => {
  const s = Buffer.from(JSON.stringify(value)).toString('base64url');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
};

function token(
  o: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    key?: KeyObject;
  } = {},
): string {
  const h = b64({ alg: 'ES256', kid: KID, signer: ALB, exp: NOW + 60, ...o.header });
  const p = b64({ sub: 'u1', email: 'Owner@Example.com', exp: NOW + 60, ...o.payload });
  const s = sign('sha256', Buffer.from(`${h}.${p}`), {
    key: o.key ?? privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${h}.${p}.${s}`;
}

function verifier(fetchKey: (kid: string) => Promise<string> = () => Promise.resolve(pem)) {
  return createAlbVerifier({ albArn: ALB, region: 'eu-west-1', nowSeconds: () => NOW, fetchKey });
}

describe('createAlbVerifier', () => {
  it('accepts a token signed by our load balancer and lower-cases the email', async () => {
    const result = await verifier().verify(token());
    expect(result).toEqual({ ok: true, value: { email: 'owner@example.com' } });
  });

  it('fetches each key once', async () => {
    let calls = 0;
    const v = verifier(() => {
      calls += 1;
      return Promise.resolve(pem);
    });
    await v.verify(token());
    await v.verify(token());
    expect(calls).toBe(1);
  });

  it.each([
    ['missing', undefined, 'missing'],
    ['empty', '', 'missing'],
    ['two parts', 'a.b', 'malformed'],
    ['not json', 'x.y.z', 'malformed'],
  ])('rejects a %s token', async (_name, value, error) => {
    expect(await verifier().verify(value)).toEqual({ ok: false, error });
  });

  it('rejects another load balancer, even with a valid signature', async () => {
    const other = ALB.replace('test-alb', 'other-alb');
    expect(await verifier().verify(token({ header: { signer: other } }))).toEqual({
      ok: false,
      error: 'wrong_signer',
    });
  });

  it('rejects other algorithms', async () => {
    expect(await verifier().verify(token({ header: { alg: 'none' } }))).toEqual({
      ok: false,
      error: 'bad_algorithm',
    });
  });

  it('rejects an expired token', async () => {
    expect(await verifier().verify(token({ header: { exp: NOW } }))).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('rejects a key id that could change the key URL', async () => {
    expect(await verifier().verify(token({ header: { kid: '../x' } }))).toEqual({
      ok: false,
      error: 'malformed',
    });
  });

  it('rejects a token signed with another key', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(await verifier().verify(token({ key: other }))).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('rejects a payload changed after signing', async () => {
    const [h, , s] = token().split('.');
    const forged = b64({ email: 'attacker@example.com', exp: NOW + 60 });
    expect(await verifier().verify(`${h ?? ''}.${forged}.${s ?? ''}`)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('fails closed when the public key cannot be fetched', async () => {
    const v = verifier(() => Promise.reject(new Error('offline')));
    expect(await v.verify(token())).toEqual({ ok: false, error: 'key_unavailable' });
  });

  it('requires an email claim', async () => {
    expect(await verifier().verify(token({ payload: { email: undefined } }))).toEqual({
      ok: false,
      error: 'no_email',
    });
  });
});
