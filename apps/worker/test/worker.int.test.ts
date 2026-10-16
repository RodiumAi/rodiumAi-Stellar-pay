import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateMemo } from '@rp/core/memo';
import { cryptoRandomBytes } from '@rp/core/random';
import { getCursor, saveCursor } from '@rp/db/cursors';
import { enqueueEvent, requeueDeadEvent } from '@rp/db/outbox';
import { findPaymentById, insertPayment } from '@rp/db/payments';
import { verifyWebhook } from '@rp/security/webhook-signature';
import type { LedgerSource, PaymentPage } from '@rp/stellar/ledger-source';
import type { ObservedPayment } from '@rp/stellar/observed-payment';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, newId, newPayment, pool } from '../../../packages/db/test/fixtures.js';
import { createDispatchJob } from '../src/jobs/dispatch.js';
import { createExpireJob } from '../src/jobs/expire.js';
import { createIngestJob, createReconcileJob, processPage } from '../src/jobs/ingest.js';
import { createMetrics } from '../src/metrics.js';

const worker = db('worker', 10);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const merchant = `G${'M'.repeat(55)}`;
const issuer = `G${'A'.repeat(55)}`;
const rules = { merchant, usdc: { code: 'USDC', issuer } };
const never = new AbortController().signal;

let ledgerSeq = 1_000;
function observed(
  memo: string | null,
  amount: string,
  overrides: Partial<ObservedPayment> = {},
): ObservedPayment {
  ledgerSeq += 1;
  return {
    cursor: String(ledgerSeq),
    txHash: randomBytes(32).toString('hex'),
    itemIndex: 0,
    ledger: ledgerSeq,
    ledgerClosedAt: new Date(),
    successful: true,
    from: `G${'P'.repeat(55)}`,
    to: merchant,
    asset: { code: 'USDC', issuer },
    amount,
    memo: { type: memo === null ? 'none' : 'text', value: memo },
    viaContract: false,
    ...overrides,
  };
}

/** Deterministic source: payments in ledger order; cursor = position after the last item. */
function fakeSource(
  name: string,
  payments: ObservedPayment[],
): LedgerSource & { payments: ObservedPayment[] } {
  return {
    name,
    payments,
    fetchPayments(position, limit): Promise<PaymentPage> {
      const sorted = [...payments].sort((a, b) => a.ledger - b.ledger);
      const from =
        'cursor' in position
          ? position.cursor === 'now'
            ? sorted.length
            : sorted.findIndex((p) => Number(p.cursor) > Number(position.cursor))
          : sorted.findIndex((p) => p.ledger >= position.startLedger);
      const start = from === -1 ? sorted.length : from;
      const page = sorted.slice(start, start + limit);
      const cursor =
        page.at(-1)?.cursor ??
        ('cursor' in position ? position.cursor : String(position.startLedger - 1));
      return Promise.resolve({ payments: page, cursor, latestLedger: ledgerSeq });
    },
  };
}

async function payment(amountDue: bigint, overrides = {}) {
  const r = await insertPayment(
    db('api'),
    newPayment({ amount_due_stroops: amountDue, destination: merchant, ...overrides }),
  );
  if (!r.ok) throw new Error(r.error);
  return r.value.row;
}

const events = (aggregateId: string) =>
  worker
    .selectFrom('outbox_events')
    .select(['event_type', 'payload'])
    .where('aggregate_id', '=', aggregateId)
    .orderBy('created_at')
    .execute();

describe('ingest pipeline (context §13.4)', () => {
  it('underpay then top-up → confirmed with both tx hashes', async () => {
    const p = await payment(100_000_000n);
    const a = observed(p.memo, '4.0000000');
    const b = observed(p.memo, '6.0000000');
    const source = fakeSource(`t-${newId()}`, [a, b]);
    await processPage(
      worker,
      source,
      rules,
      { startLedger: 1 },
      50,
      `payments:${source.name}`,
      silent,
    );
    expect(await findPaymentById(worker, p.id)).toMatchObject({
      status: 'confirmed',
      amount_received_stroops: 100_000_000n,
    });
    const confirmed = (await events(p.id)).find((e) => e.event_type === 'payment.confirmed');
    expect((confirmed?.payload as { tx_hashes: string[] }).tx_hashes.sort()).toEqual(
      [a.txHash, b.txHash].sort(),
    );
  });

  it('overpay → confirmed and the excess is kept (amount_received > due)', async () => {
    const p = await payment(100_000_000n);
    const source = fakeSource(`t-${newId()}`, [observed(p.memo, '13.0000000')]);
    const stats = await processPage(worker, source, rules, { startLedger: 1 }, 50, null, silent);
    expect(stats.applied).toBe(1);
    expect(await findPaymentById(worker, p.id)).toMatchObject({
      status: 'confirmed',
      amount_received_stroops: 130_000_000n,
    });
  });

  it('wrong asset and unknown memo are stored unmatched, never credited', async () => {
    const p = await payment(100_000_000n);
    const source = fakeSource(`t-${newId()}`, [
      observed(p.memo, '10.0000000', { asset: { code: 'USDC', issuer: `G${'Z'.repeat(55)}` } }),
      observed('RP0000000000ZZ', '10.0000000'),
    ]);
    const stats = await processPage(worker, source, rules, { startLedger: 1 }, 50, null, silent);
    expect(stats).toMatchObject({ applied: 0, unmatched: 2 });
    expect(await findPaymentById(worker, p.id)).toMatchObject({
      status: 'pending',
      amount_received_stroops: 0n,
    });
  });

  it('a crash mid-batch rolls back the whole page and cursor; restart applies each receipt once', async () => {
    const payments = await Promise.all([
      payment(10_000_000n),
      payment(10_000_000n),
      payment(10_000_000n),
    ]);
    const items = payments.map((p) => observed(p.memo, '1.0000000'));
    const poison = items[1]?.txHash ?? '';
    const source = fakeSource(`crash-${newId()}`, items);
    const cursorName = `payments:${source.name}`;
    // Simulated crash: the second receipt's insert fails inside the page transaction.
    await pool('owner', 1).query(`
      CREATE OR REPLACE FUNCTION pay.test_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF encode(NEW.tx_hash, 'hex') = '${poison}' THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_crash BEFORE INSERT ON pay.chain_receipts FOR EACH ROW EXECUTE FUNCTION pay.test_crash();`);
    try {
      await expect(
        processPage(worker, source, rules, { startLedger: 1 }, 50, cursorName, silent),
      ).rejects.toThrow('simulated crash');
      expect(await getCursor(worker, cursorName)).toBeUndefined();
      for (const p of payments)
        expect((await findPaymentById(worker, p.id))?.amount_received_stroops).toBe(0n);
    } finally {
      await pool('owner', 1).query(
        'DROP TRIGGER test_crash ON pay.chain_receipts; DROP FUNCTION pay.test_crash();',
      );
    }
    await processPage(worker, source, rules, { startLedger: 1 }, 50, cursorName, silent);
    await processPage(worker, source, rules, { startLedger: 1 }, 50, cursorName, silent);
    for (const p of payments) {
      expect(await findPaymentById(worker, p.id)).toMatchObject({
        status: 'confirmed',
        amount_received_stroops: 10_000_000n,
      });
    }
    expect((await getCursor(worker, cursorName))?.cursor).toBe(items.at(-1)?.cursor);
  });

  it('two replicas: exactly one becomes ingest leader', async () => {
    const source = fakeSource(`leader-${newId()}`, []);
    const make = () => {
      const metrics = createMetrics();
      return {
        metrics,
        job: createIngestJob({
          db: worker,
          sessionPool: pool('worker', 1),
          source,
          rules,
          startLedger: 1,
          metrics,
          logger: silent,
        }),
      };
    };
    const a = make();
    const b = make();
    await Promise.all([a.job.run(never), b.job.run(never)]);
    expect(a.metrics.get('ingest_is_leader') + b.metrics.get('ingest_is_leader')).toBe(1);
    const leader = a.metrics.get('ingest_is_leader') === 1 ? a : b;
    const standby = leader === a ? b : a;
    await leader.job.release();
    await standby.job.run(never);
    expect(standby.metrics.get('ingest_is_leader')).toBe(1);
    await standby.job.release();
  });

  it('leader job persists the cursor and resumes after it', async () => {
    const p = await payment(20_000_000n);
    const source = fakeSource(`resume-${newId()}`, [observed(p.memo, '1.0000000')]);
    const metrics = createMetrics();
    const job = createIngestJob({
      db: worker,
      sessionPool: pool('worker', 1),
      source,
      rules,
      startLedger: 1,
      metrics,
      logger: silent,
    });
    await job.run(never);
    source.payments.push(observed(p.memo, '1.0000000'));
    await job.run(never);
    await job.release();
    expect(await findPaymentById(worker, p.id)).toMatchObject({
      status: 'confirmed',
      amount_received_stroops: 20_000_000n,
    });
    expect(metrics.get('receipts_applied_total')).toBe(2);
  });

  it('reconciliation fills a gap behind the cursor, idempotently', async () => {
    const p = await payment(30_000_000n);
    const missed = observed(p.memo, '3.0000000');
    const source = fakeSource(`gap-${newId()}`, [missed]);
    await saveCursor(worker, `payments:${source.name}`, {
      cursor: String(missed.ledger + 5),
      ledger: missed.ledger + 5,
    });
    const metrics = createMetrics();
    const job = createReconcileJob({
      db: worker,
      source,
      rules,
      logger: silent,
      metrics,
      windowLedgers: 50,
    });
    await job.run(never);
    await job.run(never);
    expect(await findPaymentById(worker, p.id)).toMatchObject({
      status: 'confirmed',
      amount_received_stroops: 30_000_000n,
    });
    expect(metrics.get('reconcile_filled_total')).toBe(1);
  });
});

describe('expiry', () => {
  it('expires overdue payments with an event; later money goes to late_paid', async () => {
    const p = await payment(10_000_000n, { expires_at: new Date(Date.now() - 1000) });
    await createExpireJob({
      db: worker,
      now: () => new Date(),
      randomBytes: cryptoRandomBytes,
    }).run(never);
    expect((await findPaymentById(worker, p.id))?.status).toBe('expired');
    expect((await events(p.id)).map((e) => e.event_type)).toContain('payment.expired');
    const source = fakeSource(`late-${newId()}`, [observed(p.memo, '1.0000000')]);
    await processPage(worker, source, rules, { startLedger: 1 }, 50, null, silent);
    expect((await findPaymentById(worker, p.id))?.status).toBe('late_paid');
    expect((await events(p.id)).map((e) => e.event_type)).toContain('payment.late_paid');
  });
});

describe('webhook dispatch (context §10)', () => {
  const keys = generateKeyPairSync('ed25519');
  let server: Server;
  let url = '';
  let status = 500;
  const received: { headers: IncomingMessage['headers']; body: Buffer }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/webhooks/crypto`;
  });
  afterAll(() => {
    server.close();
  });

  it('retries 500s on the 10s→12h schedule, goes dead, and replays after admin requeue', async () => {
    const aggregateId = newId();
    const eventId = newId();
    await worker.transaction().execute((tx) =>
      enqueueEvent(tx, {
        id: eventId,
        type: 'payment.confirmed',
        aggregateId,
        payload: { payment_id: aggregateId },
      }),
    );
    let now = new Date(Date.now() + 1000);
    const metrics = createMetrics();
    const job = createDispatchJob({
      db: worker,
      url,
      signer: { keyId: 'whk_test', privateKey: keys.privateKey },
      fetch,
      now: () => now,
      randomBytes: () => Uint8Array.of(128),
      metrics,
      logger: silent,
      // Other tests leave due events in this database; lease them all so ours is included.
      batchSize: 10_000,
    });
    const row = () =>
      worker
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow();

    status = 500;
    const expectedDelays = [10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
    for (const [i, delay] of expectedDelays.entries()) {
      await job.run(never);
      const r = await row();
      expect(r.attempts).toBe(i + 1);
      expect(r.status).toBe('pending');
      expect(Math.abs(r.next_attempt_at.getTime() - now.getTime() - delay)).toBeLessThanOrEqual(
        delay * 0.1 + 1,
      );
      now = new Date(r.next_attempt_at.getTime() + 1);
    }
    await job.run(never);
    expect(await row()).toMatchObject({ status: 'dead', attempts: 8, last_error: 'HTTP 500' });
    expect(metrics.get('webhooks_dead')).toBeGreaterThanOrEqual(1);

    expect(await requeueDeadEvent(worker, eventId, now)).toBe(true);
    status = 200;
    received.length = 0;
    await job.run(never);
    expect(await row()).toMatchObject({ status: 'delivered' });

    const delivery = received.find((d) => d.headers['rp-event-id'] === eventId);
    if (delivery === undefined) throw new Error('not delivered');
    const verified = verifyWebhook(
      (k) => (k === 'whk_test' ? keys.publicKey : undefined),
      String(delivery.headers['rp-signature']),
      delivery.body,
      Math.floor(now.getTime() / 1000),
    );
    expect(verified.ok).toBe(true);
    expect(JSON.parse(delivery.body.toString())).toMatchObject({
      id: eventId,
      type: 'payment.confirmed',
      data: { payment_id: aggregateId },
    });
    expect(await requeueDeadEvent(worker, eventId, now)).toBe(false);
  });

  it('two dispatchers never deliver the same event twice concurrently', async () => {
    status = 200;
    received.length = 0;
    const ids = [newId(), newId(), newId(), newId()];
    await worker.transaction().execute(async (tx) => {
      for (const id of ids)
        await enqueueEvent(tx, {
          id,
          type: 'payment.underpaid',
          aggregateId: newId(),
          payload: {},
        });
    });
    const make = () =>
      createDispatchJob({
        db: worker,
        url,
        signer: { keyId: 'whk_test', privateKey: keys.privateKey },
        fetch,
        now: () => new Date(Date.now() + 1000),
        randomBytes: cryptoRandomBytes,
        metrics: createMetrics(),
        logger: silent,
      });
    await Promise.all([make().run(never), make().run(never)]);
    const mine = received.filter((d) => ids.includes(String(d.headers['rp-event-id'])));
    expect(mine).toHaveLength(4);
    expect(new Set(mine.map((d) => d.headers['rp-event-id'])).size).toBe(4);
  });
});

describe('memo helper sanity', () => {
  it('fixtures generate distinct memos', () => {
    expect(generateMemo(cryptoRandomBytes)).not.toBe(generateMemo(cryptoRandomBytes));
  });
});
