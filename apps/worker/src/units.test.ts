import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { nextAttemptAt, WEBHOOK_RETRY_DELAYS_MS } from './backoff.js';
import { createMetrics } from './metrics.js';
import { startScheduler, type Job } from './scheduler.js';
import { deliverWebhook, webhookBody } from './webhook.js';
import { loadWorkerConfig } from './worker-config.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('backoff (context §10.1)', () => {
  const now = new Date(0);
  it('follows 10s, 1m, 5m, 30m, 2h, 6h, 12h then dead', () => {
    const mid = () => Uint8Array.of(128);
    WEBHOOK_RETRY_DELAYS_MS.forEach((delay, i) => {
      const at = nextAttemptAt(i + 1, now, mid);
      expect(Math.abs((at?.getTime() ?? 0) - delay)).toBeLessThan(delay * 0.01 + 1);
    });
    expect(nextAttemptAt(8, now, mid)).toBeNull();
  });

  it('jitters within ±10%', () => {
    expect(nextAttemptAt(1, now, () => Uint8Array.of(0))?.getTime()).toBe(9_000);
    expect(nextAttemptAt(1, now, () => Uint8Array.of(255))?.getTime()).toBe(11_000);
  });
});

describe('scheduler (context §15)', () => {
  it('runs jobs repeatedly and drains in-flight work on stop', async () => {
    let runs = 0;
    let finishedAfterStop = false;
    // Stop while the second pass is in flight (a fixed delay could land between passes).
    let secondStarted: () => void = () => undefined;
    const inSecond = new Promise<void>((r) => (secondStarted = r));
    const job: Job = {
      name: 'slow',
      intervalMs: 5,
      async run(signal) {
        runs += 1;
        if (runs === 2) secondStarted();
        await new Promise((r) => setTimeout(r, 30));
        if (signal.aborted) finishedAfterStop = true;
      },
    };
    const s = startScheduler([job], silent);
    await inSecond;
    const { drained } = await s.stop(1000);
    expect(drained).toBe(true);
    expect(runs).toBeGreaterThan(1);
    expect(finishedAfterStop).toBe(true);
    const before = runs;
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(before);
  });

  it('reports not drained when work outlives the grace period', async () => {
    const s = startScheduler(
      [{ name: 'stuck', intervalMs: 1, run: () => new Promise((r) => setTimeout(r, 500)) }],
      silent,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(await s.stop(20)).toEqual({ drained: false });
  });

  it('keeps going after a failing pass', async () => {
    const error = vi.fn();
    let runs = 0;
    const s = startScheduler(
      [
        {
          name: 'flaky',
          intervalMs: 1,
          run: () => {
            runs += 1;
            return Promise.reject(new Error('boom'));
          },
        },
      ],
      { ...silent, error },
    );
    await new Promise((r) => setTimeout(r, 30));
    await s.stop(100);
    expect(runs).toBeGreaterThan(1);
    expect(error).toHaveBeenCalled();
  });
});

describe('webhook delivery', () => {
  const keys = generateKeyPairSync('ed25519');
  const event = {
    id: '01a14243-b277-7e6f-b28d-e0efc3515d7e',
    event_type: 'payment.confirmed',
    aggregate_id: 'x',
    payload: { payment_id: 'p1' },
    status: 'pending' as const,
    attempts: 0,
    next_attempt_at: new Date(0),
    last_error: null,
    created_at: new Date('2026-10-16T00:00:00Z'),
    delivered_at: null,
  };

  it('sends the documented envelope with a signature header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const result = await deliverWebhook(
      'https://main.app/hook',
      event,
      { keyId: 'whk_1', privateKey: keys.privateKey },
      1_760_000_000,
      fetch,
    );
    expect(result).toEqual({ ok: true });
    const [, init] = fetch.mock.calls[0] ?? [];
    const sent = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : '';
    expect(JSON.parse(sent)).toEqual({
      id: event.id,
      type: 'payment.confirmed',
      created_at: '2026-10-16T00:00:00.000Z',
      data: { payment_id: 'p1' },
    });
    expect(new Headers(init?.headers).get('rp-signature')).toMatch(/^t=1760000000,k=whk_1,s=/);
    expect(init?.redirect).toBe('error');
    expect(webhookBody(event).toString()).toBe(sent);
  });

  it('treats non-2xx and network errors as failures', async () => {
    const signer = { keyId: 'whk_1', privateKey: keys.privateKey };
    expect(
      await deliverWebhook('https://x', event, signer, 1, () =>
        Promise.resolve(new Response('', { status: 503 })),
      ),
    ).toEqual({
      ok: false,
      error: 'HTTP 503',
    });
    expect(
      await deliverWebhook('https://x', event, signer, 1, () =>
        Promise.reject(new TypeError('fetch failed')),
      ),
    ).toEqual({
      ok: false,
      error: 'TypeError',
    });
  });
});

describe('metrics', () => {
  it('renders Prometheus text', () => {
    const m = createMetrics();
    m.set('ingest_lag_ledgers', 3);
    m.inc('webhooks_delivered_total');
    m.inc('webhooks_delivered_total', 2);
    expect(m.render()).toBe('ingest_lag_ledgers 3\nwebhooks_delivered_total 3\n');
  });
});

describe('loadWorkerConfig', () => {
  const pem = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const valid = {
    DATABASE_URL_WORKER: 'postgresql://rp_worker:x@localhost/db',
    WEBHOOK_URL: 'http://localhost:3000/webhooks/crypto',
    WEBHOOK_SIGNING_KEY_ID: 'whk_2026_10',
    WEBHOOK_SIGNING_KEY_PEM: pem.trim().replaceAll('\n', '\\n'),
  };

  it('loads with escaped-newline PEM and defaults', () => {
    const r = loadWorkerConfig(valid);
    expect(r.ok && r.value).toMatchObject({
      port: 9090,
      ingestSource: 'horizon',
      ingestStartLedger: null,
    });
  });

  it.each<[string, Record<string, string>]>([
    ['http webhook in production', { NODE_ENV: 'production' }],
    ['rpc without a start ledger', { INGEST_SOURCE: 'rpc' }],
    [
      'non-Ed25519 key',
      {
        WEBHOOK_SIGNING_KEY_PEM: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      },
    ],
    [
      'garbage PEM',
      { WEBHOOK_SIGNING_KEY_PEM: '-----BEGIN PRIVATE KEY-----\\nnope\\n-----END PRIVATE KEY-----' },
    ],
  ])('rejects %s', (_n, override) => {
    expect(loadWorkerConfig({ ...valid, ...override }).ok).toBe(false);
  });
});
