import { randomBytes } from 'node:crypto';
import { TESTNET } from '@rp/config/network';
import type { StellarAddress } from '@rp/core/stellar-address';
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import axe from 'axe-core';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../../packages/db/test/fixtures.js';
import { checkoutHeaders } from '../src/checkout/headers.js';
import type { CheckoutDeps } from '../src/checkout/routes.js';
import {
  appConfig,
  BLOCKED_WALLET,
  harness,
  paymentBody,
  signed,
  type Harness,
} from './harness.js';

const merchant = Keypair.random().publicKey() as StellarAddress;
const user = Keypair.random();
const app = {
  ...appConfig,
  network: { ...appConfig.network, merchant, horizonUrl: 'https://horizon.test' },
};

const horizonCalls: { url: string; init?: RequestInit }[] = [];
let horizonSubmitStatus = 200;
let horizonResultCodes: unknown = { transaction: 'tx_failed' };
const horizonFetch = vi.fn<typeof fetch>((input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  horizonCalls.push({ url, ...(init === undefined ? {} : { init }) });
  if (url.endsWith(`/accounts/${user.publicKey()}`)) {
    return Promise.resolve(new Response(JSON.stringify({ sequence: '1000' })));
  }
  if (url.includes('/accounts/')) return Promise.resolve(new Response('{}', { status: 404 }));
  if (url.endsWith('/transactions')) {
    return Promise.resolve(
      new Response(
        JSON.stringify(
          horizonSubmitStatus === 200
            ? { hash: 'x' }
            : { extras: { result_codes: horizonResultCodes } },
        ),
        {
          status: horizonSubmitStatus,
        },
      ),
    );
  }
  return Promise.resolve(new Response('{}', { status: 500 }));
});

const checkout: CheckoutDeps = {
  assets: {
    page: { script: '/c/assets/main-test.js', styles: ['/c/assets/main-test.css'] },
    files: new Map([
      ['main-test.js', Buffer.from('console.log(1)')],
      ['main-test.css', Buffer.from('body{}')],
    ]),
  },
  horizonFetch,
  // Payment tests never reach Soroban; subscription checkout has its own tests.
  soroban: {
    getAccount: () => Promise.reject(new Error('unused')),
    getLatestLedger: () => Promise.reject(new Error('unused')),
    getLedgerEntries: () => Promise.reject(new Error('unused')),
    prepareTransaction: () => Promise.reject(new Error('unused')),
    simulateTransaction: () => Promise.reject(new Error('unused')),
    sendTransaction: () => Promise.reject(new Error('unused')),
    getTransaction: () => Promise.reject(new Error('unused')),
  },
};

let h: Harness;
beforeAll(async () => {
  h = await harness({}, app, checkout);
});

async function createPayment(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; token: string }> {
  const res = await h.server.inject(signed('POST', '/v1/payments', paymentBody(overrides)));
  const body = JSON.parse(res.body) as { id: string; checkout_url: string };
  return { id: body.id, token: body.checkout_url.split('/c/')[1] ?? '' };
}

const SECURITY = new Map(Object.entries(checkoutHeaders('x')));
function expectSecurityHeaders(headers: Record<string, unknown>): void {
  const got = new Map(Object.entries(headers));
  for (const [name, value] of SECURITY) {
    if (name === 'content-security-policy') continue;
    expect(got.get(name), name).toBe(value);
  }
  const csp = String(got.get('content-security-policy'));
  for (const directive of [
    "default-src 'none'",
    "style-src 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    expect(csp).toContain(directive);
  }
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
}

describe('GET /c/:token', () => {
  it('renders amount, asset, destination and memo in plain text with a nonce-bound CSP', async () => {
    const { token } = await createPayment();
    const res = await h.server.inject({ method: 'GET', url: `/c/${token}` });
    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(
      String(res.headers['content-security-policy']),
    )?.[1];
    expect(nonce).toBeDefined();
    const doc = new JSDOM(res.body).window.document;
    expect(doc.querySelector('.amount')?.textContent).toBe('19.99 USDC');
    const text = doc.body.textContent;
    expect(text).toContain(merchant);
    expect(text).toContain(TESTNET.usdc.issuer);
    expect(text).toMatch(/RP[0-9A-HJKMNP-TV-Z]{12}/);
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts.filter((s) => s.type === 'module').map((s) => s.getAttribute('nonce'))).toEqual([
      nonce,
    ]);
    expect(
      scripts.filter((s) => s.type !== 'module' && s.type !== 'application/json'),
    ).toHaveLength(0);
    expect(res.body).not.toMatch(/\sstyle=|\son[a-z]+=|javascript:/i);
    expect(doc.querySelector('svg.qr')).not.toBeNull();
    expect(doc.querySelector('a.btn')?.getAttribute('href')).toMatch(
      /^web\+stellar:pay\?destination=/,
    );
  });

  it('escapes merchant-supplied text', async () => {
    const { token } = await createPayment({ description: '</script><img src=x onerror=alert(1)>' });
    const res = await h.server.inject({ method: 'GET', url: `/c/${token}` });
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it.each(['A'.repeat(43), 'short', '../../etc/passwd'])(
    'unknown or malformed token %j → the same 404',
    async (token) => {
      const res = await h.server.inject({ method: 'GET', url: `/c/${encodeURIComponent(token)}` });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        error: { code: 'not_found', message: 'This payment link is not valid' },
      });
      expectSecurityHeaders(res.headers);
    },
  );

  it('tokens older than 24 h → 404', async () => {
    const { id, token } = await createPayment();
    await db('worker')
      .updateTable('payments')
      .set({ status: 'pending' })
      .where('id', '=', id)
      .execute();
    await db('owner')
      .updateTable('payments')
      .set({ created_at: new Date(Date.now() - 25 * 3600_000) })
      .where('id', '=', id)
      .execute();
    expect((await h.server.inject({ method: 'GET', url: `/c/${token}` })).statusCode).toBe(404);
    expect((await h.server.inject({ method: 'GET', url: `/c/${token}/status` })).statusCode).toBe(
      404,
    );
  });

  it('final payments → page 404 but status still reports the outcome', async () => {
    const { id, token } = await createPayment();
    await db('worker')
      .updateTable('payments')
      .set({ status: 'expired' })
      .where('id', '=', id)
      .execute();
    expect((await h.server.inject({ method: 'GET', url: `/c/${token}` })).statusCode).toBe(404);
    const status = await h.server.inject({ method: 'GET', url: `/c/${token}/status` });
    expect(JSON.parse(status.body)).toMatchObject({
      status: 'expired',
      final: true,
      return_url: 'https://app.rodium.test/billing/return',
    });
  });

  it('passes axe accessibility checks', async () => {
    const { token } = await createPayment();
    const res = await h.server.inject({ method: 'GET', url: `/c/${token}` });
    const dom = new JSDOM(res.body, { runScripts: 'outside-only' });
    dom.window.eval(axe.source);
    const inPage = (dom.window as unknown as { axe: typeof axe }).axe;
    // Contrast needs real layout/rendering, which jsdom does not do.
    const results: axe.AxeResults = await inPage.run(dom.window.document, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    const doc = dom.window.document;
    const button = doc.getElementById('pay-freighter');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.textContent).toBe('Pay with Varial');
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
  });
});

describe('GET /c/:token/status', () => {
  it('returns an ETag and 304 when unchanged', async () => {
    const { token } = await createPayment();
    const first = await h.server.inject({ method: 'GET', url: `/c/${token}/status` });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      status: 'pending',
      final: false,
      amount_due: '19.9900000',
      return_url: null,
    });
    const etag = String(first.headers.etag);
    const second = await h.server.inject({
      method: 'GET',
      url: `/c/${token}/status`,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expectSecurityHeaders(second.headers);
  });
});

function signedPayment(
  o: { destination?: string; amount?: string; memo?: string; asset?: Asset; maxTime?: number } = {},
): string {
  const tx = new TransactionBuilder(new Account(user.publicKey(), '1000'), {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
    memo: Memo.text(o.memo ?? 'RP0000000000ZZ'),
    timebounds: { minTime: 0, maxTime: o.maxTime ?? Math.floor(Date.now() / 1000) + 120 },
  })
    .addOperation(
      Operation.payment({
        destination: o.destination ?? merchant,
        asset: o.asset ?? new Asset('USDC', TESTNET.usdc.issuer),
        amount: o.amount ?? '19.99',
      }),
    )
    .build();
  tx.sign(user);
  return tx.toXdr();
}

describe('prepare → sign → submit', () => {
  it('the server-built transaction, once signed, passes the guard and is relayed exactly once', async () => {
    const { token } = await createPayment();
    const prepared = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/prepare`,
      payload: { address: user.publicKey() },
    });
    expect(prepared.statusCode).toBe(200);
    const { xdr } = JSON.parse(prepared.body) as { xdr: string };
    const tx = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
    if (!('sign' in tx)) throw new Error('bad tx');
    tx.sign(user);
    horizonSubmitStatus = 200;
    const before = horizonCalls.filter((c) => c.url.endsWith('/transactions')).length;
    const submit = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/submit`,
      payload: { xdr: tx.toXdr() },
    });
    expect(submit.statusCode).toBe(200);
    expect(JSON.parse(submit.body)).toMatchObject({
      status: 'submitted',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    const again = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/submit`,
      payload: { xdr: tx.toXdr() },
    });
    expect(again.statusCode).toBe(409);
    expect(horizonCalls.filter((c) => c.url.endsWith('/transactions')).length - before).toBe(1);
  });

  it('tells the customer why the network refused the payment', async () => {
    const { token } = await createPayment();
    const prepared = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/prepare`,
      payload: { address: user.publicKey() },
    });
    const tx = TransactionBuilder.fromXdr(
      (JSON.parse(prepared.body) as { xdr: string }).xdr,
      Networks.TESTNET,
    );
    if (!('sign' in tx)) throw new Error('bad tx');
    tx.sign(user);
    horizonSubmitStatus = 400;
    horizonResultCodes = { transaction: 'tx_failed', operations: ['op_underfunded'] };
    try {
      const res = await h.server.inject({
        method: 'POST',
        url: `/c/${token}/submit`,
        payload: { xdr: tx.toXdr() },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body)).toMatchObject({
        error: {
          code: 'submit_failed',
          message: "Your wallet doesn't have enough USDC for this payment. Add USDC and try again.",
        },
      });
    } finally {
      horizonSubmitStatus = 200;
      horizonResultCodes = { transaction: 'tx_failed' };
    }
  });

  it('refuses a blocked wallet before loading or building anything', async () => {
    const { token } = await createPayment();
    const before = horizonCalls.length;
    const res = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/prepare`,
      payload: { address: BLOCKED_WALLET },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'validation_failed', message: 'This wallet cannot be used for payment' },
    });
    expect(horizonCalls.length).toBe(before);
    expect(h.logs.some((l) => l.includes('"alert":"sanctioned_wallet"'))).toBe(true);
  });

  it('rejects an account that is not active', async () => {
    const { token } = await createPayment();
    const res = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/prepare`,
      payload: { address: Keypair.random().publicKey() },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each<[string, (memo: string) => string]>([
    [
      'wrong destination',
      (memo) => signedPayment({ memo, destination: Keypair.random().publicKey() }),
    ],
    ['wrong amount', (memo) => signedPayment({ memo, amount: '19.98' })],
    ['wrong memo', () => signedPayment({ memo: 'RP0000000000ZZ' })],
    [
      'wrong issuer',
      (memo) => signedPayment({ memo, asset: new Asset('USDC', Keypair.random().publicKey()) }),
    ],
    [
      'long time bounds',
      (memo) => signedPayment({ memo, maxTime: Math.floor(Date.now() / 1000) + 3600 }),
    ],
    ['garbage', () => 'AAAA'],
  ])('rejects %s with 422 invalid_transaction and a security log', async (_name, make) => {
    const { id, token } = await createPayment();
    const row = await db('worker')
      .selectFrom('payments')
      .select('memo')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const logsBefore = h.logs.length;
    const res = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/submit`,
      payload: { xdr: make(row.memo) },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'invalid_transaction' } });
    expect(h.logs.slice(logsBefore).join('')).toContain('"security":true');
  });

  it('fails closed when the submission store is down', async () => {
    const { id, token } = await createPayment();
    const row = await db('worker')
      .selectFrom('payments')
      .select('memo')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    h.kv.down = true;
    try {
      const res = await h.server.inject({
        method: 'POST',
        url: `/c/${token}/submit`,
        payload: { xdr: signedPayment({ memo: row.memo }) },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      h.kv.down = false;
    }
  });

  it('serves only manifest-listed assets with security headers', async () => {
    const ok = await h.server.inject({ method: 'GET', url: '/c/assets/main-test.js' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/javascript');
    expectSecurityHeaders({ ...ok.headers, 'cache-control': 'no-store' });
    expect(
      (await h.server.inject({ method: 'GET', url: '/c/assets/..%2F..%2Fpackage.json' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await h.server.inject({
          method: 'GET',
          url: `/c/assets/${randomBytes(4).toString('hex')}.js`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
