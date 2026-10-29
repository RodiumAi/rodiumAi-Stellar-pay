import { err, ok } from '@rp/core/result';
import { createLogger } from '@rp/security/logger';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdminQueries,
  Overview,
  PaymentDetail,
  PaymentFilter,
  PaymentRow,
} from './queries.js';
import { buildServer, type AdminDeps } from './server.js';
import type { StatusProbes } from './status.js';

const BASE = '/ops';
const OWNER = 'owner@example.com';
const ID = '01a182c6-eeaa-79fd-bd3c-9a3d18f21fe5';

const row: PaymentRow = {
  id: ID,
  merchantOrderId: '<img src=x onerror=alert(1)>',
  description: 'Pilot',
  status: 'confirmed',
  fiatCurrency: 'USD',
  fiatAmountMinor: 10n,
  amountDue: 1_000_000n,
  amountReceived: 1_000_000n,
  createdAt: new Date('2026-10-28T13:50:37Z'),
  confirmedAt: new Date('2026-10-28T13:55:13Z'),
};

const overview: Overview = {
  day: { created: 2, confirmed: 1, confirmedVolume: 1_000_000n },
  week: { created: 2, confirmed: 1, confirmedVolume: 1_000_000n },
  openPayments: 1,
  receiptsUnmatched: 0,
  webhooksPending: 1,
  webhooksDead: 0,
  workerLeaseExpiresAt: new Date('2026-10-29T00:01:00Z'),
  lastIngestedLedger: 65_181_600,
  recent: [row],
};

const detail: PaymentDetail = {
  ...row,
  memo: 'RP0123456789AB',
  destination: `G${'B'.repeat(55)}`,
  fxRate: '1.000000000000000000',
  returnUrl: 'https://example.com/return',
  expiresAt: new Date('2026-10-28T14:10:37Z'),
  updatedAt: new Date('2026-10-28T13:55:13Z'),
  receipts: [],
  webhooks: [],
  audit: [],
};

function setup(overrides: Partial<AdminDeps> = {}) {
  const queries = {
    overview: vi.fn(() => Promise.resolve(overview)),
    payments: vi.fn<(filter: PaymentFilter) => Promise<readonly PaymentRow[]>>(() =>
      Promise.resolve([row]),
    ),
    payment: vi.fn((id: string) => Promise.resolve(id === ID ? detail : null)),
    receipts: vi.fn(() => Promise.resolve([])),
    webhooks: vi.fn(() => Promise.resolve([])),
  } satisfies AdminQueries;
  const probes: StatusProbes = {
    treasury: () => Promise.resolve({ usdc: '0.1000000', xlm: '18.7299466' }),
    apiReady: () => Promise.resolve({ ready: true, checks: { database: true } }),
  };
  const authenticate = vi.fn((token: string | undefined) =>
    Promise.resolve(
      token === 'good'
        ? ok({ email: OWNER })
        : token === 'stranger'
          ? ok({ email: 'stranger@example.com' })
          : err('missing' as const),
    ),
  );
  const app = buildServer({
    basePath: BASE,
    network: 'mainnet',
    treasury: `G${'B'.repeat(55)}`,
    allowedEmails: new Set([OWNER]),
    logoutUrl: 'https://login.example.com/logout?client_id=x',
    authenticate,
    queries,
    probes,
    logger: createLogger({ level: 'silent', service: 'admin' }),
    now: () => new Date('2026-10-29T00:00:00Z'),
    ...overrides,
  });
  const get = (url: string, token: string | null = 'good') =>
    app.inject({
      method: 'GET',
      url,
      headers: token === null ? {} : { 'x-amzn-oidc-data': token },
    });
  return { app, queries, authenticate, get };
}

describe('admin server', () => {
  it('requires a verified sign-in on every dashboard path', async () => {
    const { get } = setup();
    for (const path of [BASE, `${BASE}/`, `${BASE}/payments`, `${BASE}/admin.css`, `${BASE}/x`]) {
      expect((await get(path, null)).statusCode).toBe(401);
    }
  });

  it('refuses a signed-in account that is not on the allow-list', async () => {
    const res = await setup().get(BASE, 'stranger');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Treasury');
  });

  it('renders the overview with strict security headers and escaped data', async () => {
    const res = await setup().get(BASE);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Mainnet · real money');
    expect(res.body).toContain('0.1000000');
    expect(res.body).toContain('running');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.body).toContain(OWNER);
  });

  it('passes only valid filters to the database', async () => {
    const { get, queries } = setup();
    await get(`${BASE}/payments?status=confirmed&q=%20order-1%20&before=${ID.toUpperCase()}`);
    expect(queries.payments).toHaveBeenLastCalledWith({
      status: 'confirmed',
      search: 'order-1',
      before: ID,
    });
    await get(`${BASE}/payments?status=drop+table&before=1;--`);
    expect(queries.payments).toHaveBeenLastCalledWith({ status: null, search: null, before: null });
  });

  it('shows one payment and 404s an unknown one', async () => {
    const { get } = setup();
    const res = await get(`${BASE}/payments/${ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('RP0123456789AB');
    expect((await get(`${BASE}/payments/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(
      404,
    );
  });

  it('defaults receipts to unmatched and webhooks to dead', async () => {
    const { get, queries } = setup();
    await get(`${BASE}/receipts?match=bogus`);
    expect(queries.receipts).toHaveBeenLastCalledWith('unmatched', null);
    await get(`${BASE}/webhooks`);
    expect(queries.webhooks).toHaveBeenLastCalledWith('dead', null);
  });

  it('signs out by clearing the load balancer session and going to the login service', async () => {
    const res = await setup().get(`${BASE}/logout`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://login.example.com/logout?client_id=x');
    expect(String(res.headers['set-cookie'])).toContain('AWSELBAuthSessionCookie-0=;');
  });

  it('serves the health check without sign-in and nothing outside the dashboard path', async () => {
    const { get, authenticate } = setup();
    expect((await get('/health/live', null)).statusCode).toBe(200);
    expect((await get('/v1/payments', null)).statusCode).toBe(404);
    expect((await get('/opsx', null)).statusCode).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('hides internal errors', async () => {
    const { get } = setup({
      queries: {
        overview: () => Promise.reject(new Error('password=hunter2 connection refused')),
        payments: () => Promise.resolve([]),
        payment: () => Promise.resolve(null),
        receipts: () => Promise.resolve([]),
        webhooks: () => Promise.resolve([]),
      },
    });
    const res = await get(BASE);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
  });
});
