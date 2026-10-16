import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blindIndex, normalizeForIndex } from './blind-index.js';
import { constantTimeEqual, decodeBase64Url } from './encoding.js';
import { deriveCheckoutToken, hashCheckoutToken, issueCheckoutToken } from './tokens.js';

describe('checkout tokens (context §11.2)', () => {
  it('issues 32-byte base64url tokens and stores only the hash', () => {
    const { token, hash } = issueCheckoutToken(randomBytes);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash.length).toBe(32);
    expect(hashCheckoutToken(token)?.equals(hash)).toBe(true);
  });

  it.each(['', 'abc', `${'A'.repeat(43)}=`, 'A'.repeat(44), '+'.repeat(43)])('rejects %j', (t) => {
    expect(hashCheckoutToken(t)).toBeNull();
  });
});

describe('deriveCheckoutToken', () => {
  const key = randomBytes(32);

  it('is deterministic per id, distinct across ids and keys, and hash-only verifiable', () => {
    const a = deriveCheckoutToken(key, 'payment:1');
    expect(deriveCheckoutToken(key, 'payment:1')).toEqual(a);
    expect(deriveCheckoutToken(key, 'payment:2').token).not.toBe(a.token);
    expect(deriveCheckoutToken(key, 'subscription:1').token).not.toBe(a.token);
    expect(deriveCheckoutToken(randomBytes(32), 'payment:1').token).not.toBe(a.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashCheckoutToken(a.token)?.equals(a.hash)).toBe(true);
  });

  it('refuses short keys', () => {
    expect(() => deriveCheckoutToken(randomBytes(16), 'payment:1')).toThrow();
  });
});

describe('blind index', () => {
  const key = randomBytes(32);

  it('is deterministic over normalized input and key-dependent', () => {
    expect(blindIndex(key, ' cust-1 ').equals(blindIndex(key, 'cust-1'))).toBe(true);
    expect(blindIndex(key, 'cust-1').equals(blindIndex(randomBytes(32), 'cust-1'))).toBe(false);
    expect(normalizeForIndex('é')).toBe('é');
  });

  it('refuses short keys', () => {
    expect(() => blindIndex(randomBytes(16), 'x')).toThrow();
  });
});

describe('encoding', () => {
  it('compares in constant time including length', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });

  it('decodes only canonical base64url', () => {
    expect(decodeBase64Url('AQID')).toEqual(Buffer.from([1, 2, 3]));
    expect(decodeBase64Url('AQI=')).toBeNull();
    expect(decodeBase64Url('AQJ')).toBeNull();
  });
});
