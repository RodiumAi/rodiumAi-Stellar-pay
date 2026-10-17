import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDocsSite } from '../src/docs/routes.js';
import { appConfig, harness, type Harness } from './harness.js';

const dir = mkdtempSync(join(tmpdir(), 'rp-docs-'));
/* eslint-disable security/detect-non-literal-fs-filename -- temp dir created above */
mkdirSync(join(dir, 'docs'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>StelPay</title>');
writeFileSync(join(dir, 'docs', 'quickstart.html'), '<!doctype html><title>Quickstart</title>');
writeFileSync(join(dir, 'assets', 'docs.abc123.css'), 'body{}');
writeFileSync(join(dir, 'stelpay-docs.md'), '# StelPay');
/* eslint-enable security/detect-non-literal-fs-filename */

let h: Harness;
beforeAll(async () => {
  h = await harness({}, appConfig, undefined, loadDocsSite(dir));
});

describe('documentation site', () => {
  it('serves the landing page at / with a strict CSP and no auth', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>StelPay</title>');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('serves pages, redirects /docs and 404s unknown pages', async () => {
    expect((await h.server.inject({ method: 'GET', url: '/docs/quickstart' })).statusCode).toBe(
      200,
    );
    const redirect = await h.server.inject({ method: 'GET', url: '/docs' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/docs/quickstart');
    const missing = await h.server.inject({ method: 'GET', url: '/docs/nope' });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: 'not_found' } });
    expect((await h.server.inject({ method: 'GET', url: '/docs/..%2F..%2Fetc' })).statusCode).toBe(
      404,
    );
  });

  it('serves hashed assets with long-lived caching', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/docs-assets/docs.abc123.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(
      (await h.server.inject({ method: 'GET', url: '/docs-assets/missing.css' })).statusCode,
    ).toBe(404);
  });

  it('serves the whole guide as Markdown, and 404s a missing llms.txt', async () => {
    const res = await h.server.inject({ method: 'GET', url: '/stelpay-docs.md' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toBe('# StelPay');
    expect((await h.server.inject({ method: 'GET', url: '/llms.txt' })).statusCode).toBe(404);
  });

  it('leaves the signed API untouched', async () => {
    const res = await h.server.inject({ method: 'POST', url: '/v1/payments', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
