import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTlsFiles } from './tls-files.js';

const dir = mkdtempSync(join(tmpdir(), 'rp-tls-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function selfSigned(name: string, days: number): { key: Buffer; cert: Buffer } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      String(days),
      '-subj',
      `/CN=${name}`,
    ],
    { stdio: 'ignore' },
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir from mkdtemp
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

describe('mTLS files (context §12.1)', () => {
  const a = selfSigned('a', 30);
  const b = selfSigned('b', 60);

  it('reloads renewed files after the refresh interval and reports expiry', () => {
    let files = { '/k': a.key, '/c': a.cert, '/ca': a.cert };
    let now = 0;
    const reloads: number[] = [];
    const tls = createTlsFiles({
      keyPath: '/k',
      certPath: '/c',
      caPath: '/ca',
      refreshMs: 1000,
      nowMs: () => now,
      read: (p) => new Map(Object.entries(files)).get(p) ?? Buffer.alloc(0),
      onReload: (m) => reloads.push(m.notAfterSeconds),
    });
    const first = tls.current();
    expect(first.cert.equals(a.cert)).toBe(true);
    const days = (first.notAfterSeconds * 1000 - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);

    files = { '/k': b.key, '/c': b.cert, '/ca': b.cert };
    now = 500;
    expect(tls.current().cert.equals(a.cert)).toBe(true); // not yet
    now = 1500;
    expect(tls.current().cert.equals(b.cert)).toBe(true);
    expect(reloads).toHaveLength(1);
  });

  it('keeps the previous material when a re-read fails mid-rotation', () => {
    let broken = false;
    let now = 0;
    const tls = createTlsFiles({
      keyPath: '/k',
      certPath: '/c',
      caPath: '/ca',
      refreshMs: 1000,
      nowMs: () => now,
      read: (p) => {
        if (broken && p === '/c') return Buffer.from('not a certificate');
        return p === '/k' ? a.key : a.cert;
      },
    });
    broken = true;
    now = 5000;
    expect(tls.current().cert.equals(a.cert)).toBe(true);
  });

  it('accepts the PEM itself instead of a path (ECS secrets arrive as env vars)', () => {
    const tls = createTlsFiles({
      keyPath: a.key.toString(),
      certPath: a.cert.toString().replaceAll('\n', '\\n'), // escaped newlines, as in .env files
      caPath: a.cert.toString(),
    });
    const m = tls.current();
    expect(m.key.equals(a.key)).toBe(true);
    expect(m.cert.toString().trim()).toBe(a.cert.toString().trim());
    expect(m.notAfterSeconds).toBeGreaterThan(Date.now() / 1000);
  });
});
