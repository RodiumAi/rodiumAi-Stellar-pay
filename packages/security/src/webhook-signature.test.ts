import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from './webhook-signature.js';

const current = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const NOW = 1_760_443_391;
const body = Buffer.from('{"id":"evt_1","type":"payment.confirmed"}');
const keys = new Map([['whk_2026_10', current.publicKey]]);
const find = (k: string) => keys.get(k);

describe('webhook Ed25519 signatures (context §10.3)', () => {
  it('round-trips', () => {
    const header = signWebhook(current.privateKey, 'whk_2026_10', NOW, body);
    expect(header).toMatch(/^t=1760443391,k=whk_2026_10,s=[A-Za-z0-9_-]{86}$/);
    expect(verifyWebhook(find, header, body, NOW + 299)).toEqual({
      ok: true,
      value: { keyId: 'whk_2026_10', timestamp: NOW },
    });
  });

  it('rejects a tampered body', () => {
    const header = signWebhook(current.privateKey, 'whk_2026_10', NOW, body);
    const tampered = Buffer.from(body.toString().replace('confirmed', 'refunded'));
    expect(verifyWebhook(find, header, tampered, NOW)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('rejects a timestamp swapped into the header', () => {
    const header = signWebhook(current.privateKey, 'whk_2026_10', NOW, body).replace(
      `t=${String(NOW)}`,
      `t=${String(NOW + 1)}`,
    );
    expect(verifyWebhook(find, header, body, NOW)).toEqual({ ok: false, error: 'bad_signature' });
  });

  it.each([NOW + 301, NOW - 301])('rejects stale or future timestamps (now=%d)', (now) => {
    const header = signWebhook(current.privateKey, 'whk_2026_10', NOW, body);
    expect(verifyWebhook(find, header, body, now)).toEqual({ ok: false, error: 'stale_timestamp' });
  });

  it('rejects a signature from the wrong key', () => {
    const header = signWebhook(other.privateKey, 'whk_2026_10', NOW, body);
    expect(verifyWebhook(find, header, body, NOW)).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('rejects an unknown key id', () => {
    const header = signWebhook(current.privateKey, 'whk_old', NOW, body);
    expect(verifyWebhook(find, header, body, NOW)).toEqual({ ok: false, error: 'unknown_key' });
  });

  it.each([
    '',
    't=1,k=x',
    `s=${'A'.repeat(86)},t=1,k=x`,
    `t=1,k=x,s=${'A'.repeat(85)}`,
    `t=01,k=x,s=${'A'.repeat(86)}`,
  ])('rejects malformed header %j', (header) => {
    expect(verifyWebhook(find, header, body, NOW)).toEqual({
      ok: false,
      error: 'malformed_signature_header',
    });
  });
});
