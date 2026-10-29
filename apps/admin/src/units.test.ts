import { describe, expect, it } from 'vitest';
import { loadAdminConfig } from './admin-config.js';
import { html, raw } from './html.js';
import { fiat, usdc, when } from './views.js';

const ALB =
  'arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/test-alb/0123456789abcdef';

const valid = {
  NODE_ENV: 'production',
  ADMIN_BASE_PATH: '/ops',
  ADMIN_ALLOWED_EMAILS: 'Owner@Example.com, second@example.com',
  ADMIN_ALB_ARN: ALB,
  DATABASE_URL_READONLY: 'postgresql://rp_readonly@localhost/postgres',
  RP_STELLAR_NETWORK: 'mainnet',
  MERCHANT_ADDRESS: `G${'A'.repeat(55)}`,
};

describe('loadAdminConfig', () => {
  it('loads a production config behind the load balancer', () => {
    const result = loadAdminConfig(valid);
    if (!result.ok) throw new Error(result.error.join('; '));
    expect(result.value.auth).toEqual({
      mode: 'alb',
      albArn: ALB,
      region: 'eu-west-1',
      logoutUrl: null,
    });
    expect([...result.value.allowedEmails]).toEqual(['owner@example.com', 'second@example.com']);
    expect(result.value.horizonUrl).toBe('https://horizon.stellar.org');
    expect(result.value.usdcIssuer).toMatch(/^GA5ZSEJ/);
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['dev sign-in in production', { ADMIN_AUTH: 'dev', ADMIN_DEV_EMAIL: 'a@b.co' }, 'ADMIN_AUTH'],
    ['no load balancer', { ADMIN_ALB_ARN: undefined }, 'ADMIN_ALB_ARN'],
    ['a base path with a slash inside', { ADMIN_BASE_PATH: '/a/b' }, 'ADMIN_BASE_PATH'],
    ['no allowed emails', { ADMIN_ALLOWED_EMAILS: ' , ' }, 'ADMIN_ALLOWED_EMAILS'],
    ['an http logout URL', { ADMIN_LOGOUT_URL: 'http://x.example/logout' }, 'ADMIN_LOGOUT_URL'],
  ])('rejects %s', (_name, override, variable) => {
    const result = loadAdminConfig({ ...valid, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.some((e) => e.startsWith(variable))).toBe(true);
  });

  it('allows dev sign-in outside production', () => {
    const result = loadAdminConfig({
      ...valid,
      NODE_ENV: 'development',
      ADMIN_AUTH: 'dev',
      ADMIN_DEV_EMAIL: 'Dev@Example.com',
      ADMIN_ALB_ARN: undefined,
    });
    expect(result.ok && result.value.auth).toEqual({ mode: 'dev', devEmail: 'dev@example.com' });
  });
});

describe('html', () => {
  it('escapes interpolated values but not nested fragments', () => {
    const evil = '<script>alert("x")</script>';
    const out = html`<p title="${evil}">${evil}${html`<b>${'&'}</b>`}${raw('<i>ok</i>')}</p>`;
    expect(out.toString()).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<b>&amp;</b><i>ok</i></p>',
    );
  });

  it('joins arrays and drops null, undefined and false', () => {
    expect(html`${['a', html`<br />`, null, undefined, false, 0]}`.toString()).toBe('a<br />0');
  });
});

describe('formatting', () => {
  it('shows USDC with at least two decimals', () => {
    expect(usdc(1_000_000n)).toBe('0.10');
    expect(usdc(10_165_431n)).toBe('1.0165431');
    expect(usdc(0n)).toBe('0.00');
  });

  it('shows fiat from minor units', () => {
    expect(fiat('USD', 10n)).toBe('0.10 USD');
    expect(fiat('GHS', 123_456n)).toBe('1234.56 GHS');
    expect(fiat('XOF', 500n)).toBe('500 XOF');
  });

  it('shows times in UTC', () => {
    expect(when(new Date('2026-10-28T13:55:13Z'))).toBe('2026-10-28 13:55 UTC');
    expect(when(null)).toBe('—');
  });
});
