import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, newId, newPayment, newSubscription, pool } from './fixtures.js';
import { appendAudit } from '../src/audit-log.js';
import { getCursor, saveCursor } from '../src/cursors.js';
import { tryAcquireLeaderLock } from '../src/leader-lock.js';
import { claimDueEvents, enqueueEvent, markAttemptFailed, markDelivered } from '../src/outbox.js';
import { recordPaymentReceipt, type ReceiptCandidate } from '../src/payment-receipts.js';
import {
  claimExpiringPayments,
  findPaymentById,
  findPaymentByTokenHash,
  insertPayment,
  transitionPaymentStatus,
} from '../src/payments.js';
import { receiptsForPayment } from '../src/receipts.js';
import {
  claimDueSubscriptions,
  findSubscriptionById,
  insertCharge,
  insertSubscription,
  transitionCharge,
  transitionSubscription,
} from '../src/subscriptions.js';

const api = db('api');
const worker = db('worker', 10);

function receipt(
  memo: string | null,
  amount: bigint,
  overrides: Partial<ReceiptCandidate> = {},
): ReceiptCandidate {
  return {
    id: newId(),
    txHash: randomBytes(32),
    itemIndex: 0,
    ledger: 100,
    ledgerClosedAt: new Date(),
    sourceAddress: `G${'C'.repeat(55)}`,
    destination: `G${'B'.repeat(55)}`,
    assetCode: 'USDC',
    assetIssuer: `G${'A'.repeat(55)}`,
    amount,
    memo,
    ...overrides,
  };
}

async function createPayment(overrides = {}) {
  const result = await insertPayment(api, newPayment(overrides));
  if (!result.ok) throw new Error(result.error);
  return result.value.row;
}

describe('payments', () => {
  it('round-trips int8 values beyond Number.MAX_SAFE_INTEGER as bigint', async () => {
    const big = 9_223_372_036_854_775_807n;
    const p = await createPayment({ amount_due_stroops: big, fiat_amount_minor: big });
    expect(p.amount_due_stroops).toBe(big);
    expect((await findPaymentById(api, p.id))?.fiat_amount_minor).toBe(big);
  });

  it('is idempotent on Idempotency-Key + request hash', async () => {
    const payment = newPayment();
    const first = await insertPayment(api, payment);
    const again = await insertPayment(api, {
      ...payment,
      id: newId(),
      checkout_token_hash: randomBytes(32),
    });
    expect(first.ok && first.value.created).toBe(true);
    expect(again.ok && !again.value.created && again.value.row.id).toBe(payment.id);
    const conflict = await insertPayment(api, {
      ...payment,
      id: newId(),
      request_hash: randomBytes(32),
    });
    expect(conflict).toEqual({ ok: false, error: 'idempotency_conflict' });
  });

  it('finds by checkout token hash', async () => {
    const p = await createPayment();
    expect((await findPaymentByTokenHash(api, p.checkout_token_hash))?.id).toBe(p.id);
  });

  it('treats a conditional transition that matches no row as a no-op', async () => {
    const p = await createPayment();
    expect(await transitionPaymentStatus(worker, p.id, 'underpaid', 'expired')).toBeUndefined();
    expect((await transitionPaymentStatus(worker, p.id, 'pending', 'expired'))?.status).toBe(
      'expired',
    );
    expect(await transitionPaymentStatus(worker, p.id, 'pending', 'expired')).toBeUndefined();
  });

  it('touches updated_at on update', async () => {
    const p = await createPayment();
    const updated = await transitionPaymentStatus(worker, p.id, 'pending', 'expired');
    expect(updated && updated.updated_at > p.updated_at).toBe(true);
  });

  it.each([
    ['non-positive amount due', { amount_due_stroops: 0n }],
    ['non-positive fiat amount', { fiat_amount_minor: -1n }],
    ['zero fx rate', { fx_rate: '0' }],
    ['memo over 28 bytes', { memo: 'RP'.padEnd(29, 'X') }],
    ['confirmed without confirmed_at', { status: 'confirmed' as const }],
    ['description over 140 chars', { description: 'x'.repeat(141) }],
  ])('CHECK constraints reject %s', async (_name, overrides) => {
    await expect(insertPayment(api, newPayment(overrides))).rejects.toThrow(
      /violates check constraint/,
    );
  });
});

describe('receipts → payment → outbox in one transaction', () => {
  it('confirms on exact payment and writes the event', async () => {
    const p = await createPayment();
    const outcome = await recordPaymentReceipt(
      worker,
      receipt(p.memo, p.amount_due_stroops),
      newId,
    );
    expect(outcome).toMatchObject({ kind: 'applied', eventType: 'payment.confirmed', excess: 0n });
    const after = await findPaymentById(worker, p.id);
    expect(after).toMatchObject({
      status: 'confirmed',
      amount_received_stroops: p.amount_due_stroops,
    });
    expect(after?.confirmed_at).toBeInstanceOf(Date);
    const events = await worker
      .selectFrom('outbox_events')
      .selectAll()
      .where('aggregate_id', '=', p.id)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      payment_id: p.id,
      amount_due: '19.9900000',
      amount_received: '19.9900000',
    });
  });

  it('matches memos after trimming and upper-casing', async () => {
    const p = await createPayment();
    const outcome = await recordPaymentReceipt(
      worker,
      receipt(` ${p.memo.toLowerCase()} `, 1n),
      newId,
    );
    expect(outcome).toMatchObject({ kind: 'applied', eventType: 'payment.underpaid' });
  });

  it('inserts a duplicate receipt once and changes nothing the second time', async () => {
    const p = await createPayment();
    const r = receipt(p.memo, 50_000_000n);
    expect((await recordPaymentReceipt(worker, r, newId)).kind).toBe('applied');
    expect(await recordPaymentReceipt(worker, { ...r, id: newId() }, newId)).toEqual({
      kind: 'duplicate',
    });
    expect((await findPaymentById(worker, p.id))?.amount_received_stroops).toBe(50_000_000n);
    expect(await receiptsForPayment(worker, p.id)).toHaveLength(1);
  });

  it('sums parallel receipts for one payment correctly', async () => {
    const p = await createPayment({ amount_due_stroops: 1_000n });
    const parts = Array.from({ length: 20 }, () => receipt(p.memo, 100n));
    const outcomes = await Promise.all(parts.map((r) => recordPaymentReceipt(worker, r, newId)));
    expect(outcomes.every((o) => o.kind === 'applied')).toBe(true);
    const after = await findPaymentById(worker, p.id);
    expect(after).toMatchObject({ status: 'confirmed', amount_received_stroops: 2_000n });
    const excess = outcomes.reduce((sum, o) => sum + (o.kind === 'applied' ? o.excess : 0n), 0n);
    expect(excess).toBe(1_000n);
    const events = await worker
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', p.id)
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'payment.confirmed',
      'payment.underpaid',
    ]);
  });

  it('stores unknown or missing memos as unmatched', async () => {
    expect(await recordPaymentReceipt(worker, receipt(null, 1n), newId)).toEqual({
      kind: 'unmatched',
      reason: 'no_memo',
    });
    expect(await recordPaymentReceipt(worker, receipt('RP0000000000ZZ', 1n), newId)).toEqual({
      kind: 'unmatched',
      reason: 'unknown_memo',
    });
    expect(await recordPaymentReceipt(worker, receipt('hello', 1n), newId)).toEqual({
      kind: 'unmatched',
      reason: 'unknown_memo',
    });
  });

  it('sends receipts after expiry to late_paid', async () => {
    const p = await createPayment({ expires_at: new Date(Date.now() - 1000) });
    const outcome = await recordPaymentReceipt(
      worker,
      receipt(p.memo, p.amount_due_stroops),
      newId,
    );
    expect(outcome).toMatchObject({ kind: 'applied', eventType: 'payment.late_paid' });
  });

  it('keeps receipts for refunded payments as unmatched for review', async () => {
    const p = await createPayment();
    await recordPaymentReceipt(worker, receipt(p.memo, p.amount_due_stroops), newId);
    await transitionPaymentStatus(worker, p.id, 'confirmed', 'refunded');
    expect(await recordPaymentReceipt(worker, receipt(p.memo, 1n), newId)).toEqual({
      kind: 'unmatched',
      reason: 'invalid_transition',
    });
  });
});

describe('claiming with FOR UPDATE SKIP LOCKED', () => {
  it('two workers never claim the same expiring payment', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++)
      ids.add((await createPayment({ expires_at: new Date(Date.now() - 60_000) })).id);
    const now = new Date();
    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((r) => (releaseFirst = r));
    let firstClaimed: string[] = [];
    const first = worker.transaction().execute(async (tx) => {
      firstClaimed = (await claimExpiringPayments(tx, now, 3)).map((p) => p.id);
      await firstHolds;
    });
    await new Promise((r) => setTimeout(r, 200));
    const secondClaimed = await worker
      .transaction()
      .execute(async (tx) => (await claimExpiringPayments(tx, now, 1000)).map((p) => p.id));
    releaseFirst();
    await first;
    expect(firstClaimed).toHaveLength(3);
    expect(secondClaimed.filter((id) => firstClaimed.includes(id))).toEqual([]);
  });

  it('claims due outbox events and records delivery or failure', async () => {
    const aggregate = newId();
    const ids = [newId(), newId()];
    await worker.transaction().execute(async (tx) => {
      for (const id of ids)
        await enqueueEvent(tx, {
          id,
          type: 'payment.confirmed',
          aggregateId: aggregate,
          payload: { a: 1 },
        });
    });
    const claimed = await worker
      .transaction()
      .execute((tx) => claimDueEvents(tx, new Date(Date.now() + 1000), 1000));
    expect(claimed.map((e) => e.id)).toEqual(expect.arrayContaining(ids));
    await markDelivered(worker, ids[0] ?? '', new Date());
    await markAttemptFailed(worker, ids[1] ?? '', { error: 'HTTP 500', nextAttemptAt: null });
    const rows = await worker
      .selectFrom('outbox_events')
      .selectAll()
      .where('aggregate_id', '=', aggregate)
      .execute();
    expect(rows.find((r) => r.id === ids[0])?.status).toBe('delivered');
    expect(rows.find((r) => r.id === ids[1])).toMatchObject({
      status: 'dead',
      attempts: 1,
      last_error: 'HTTP 500',
    });
  });
});

describe('subscriptions and charges', () => {
  it('inserts idempotently, transitions conditionally and claims due rows', async () => {
    const sub = newSubscription();
    const created = await insertSubscription(api, sub);
    expect(created.ok && created.value.created).toBe(true);
    expect((await insertSubscription(api, sub)).ok).toBe(true);
    expect(await insertSubscription(api, { ...sub, request_hash: randomBytes(32) })).toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });

    const activated = await transitionSubscription(api, sub.id, 'incomplete', {
      status: 'active',
      subscriber_address: `G${'D'.repeat(55)}`,
      contract_subscription_id: BigInt(Date.now()),
    });
    expect(activated?.status).toBe('active');
    expect(
      await transitionSubscription(api, sub.id, 'incomplete', { status: 'canceled' }),
    ).toBeUndefined();

    await transitionSubscription(worker, sub.id, 'active', {
      status: 'active',
      next_charge_at: new Date(Date.now() - 1000),
    });
    const due = await worker
      .transaction()
      .execute((tx) => claimDueSubscriptions(tx, new Date(), 1000));
    expect(due.map((s) => s.id)).toContain(sub.id);

    const charge = await insertCharge(worker, {
      id: newId(),
      subscription_id: sub.id,
      period_index: 1,
      amount_stroops: 99_900_000n,
    });
    expect(charge).toMatchObject({ status: 'scheduled', attempt: 1 });
    const tx = randomBytes(32);
    expect(
      (await transitionCharge(worker, charge.id, 'scheduled', 'submitted', { txHash: tx }))
        ?.tx_hash,
    ).toEqual(tx);
    expect(await transitionCharge(worker, charge.id, 'scheduled', 'failed')).toBeUndefined();
    expect((await findSubscriptionById(api, sub.id))?.status).toBe('active');
  });

  it('rejects an active subscription without a subscriber (CHECK)', async () => {
    await expect(insertSubscription(api, newSubscription({ status: 'active' }))).rejects.toThrow(
      /check constraint/,
    );
  });
});

describe('cursors, audit log and leader lock', () => {
  it('upserts ingest cursors', async () => {
    const source = `horizon-${newId()}`;
    expect(await getCursor(worker, source)).toBeUndefined();
    await saveCursor(worker, source, { cursor: 'a', ledger: 1 });
    await saveCursor(worker, source, { cursor: 'b', ledger: 2 });
    expect(await getCursor(worker, source)).toEqual({ cursor: 'b', ledger: 2 });
  });

  it('appends audit entries', async () => {
    const id = newId();
    await appendAudit(worker, {
      id,
      actor: 'admin:test',
      action: 'refund',
      targetId: newId(),
      details: { n: 1 },
    });
    expect(
      await worker
        .selectFrom('audit_log')
        .select('details')
        .where('id', '=', id)
        .executeTakeFirst(),
    ).toEqual({
      details: { n: 1 },
    });
  });

  it('lets only one session hold the ingester lock; the second waits until release', async () => {
    const p = pool('worker', 2);
    const a = await p.connect();
    const b = await p.connect();
    try {
      const key = 42n;
      const lockA = await tryAcquireLeaderLock(a, key);
      expect(lockA).not.toBeNull();
      expect(await tryAcquireLeaderLock(b, key)).toBeNull();
      await lockA?.release();
      const lockB = await tryAcquireLeaderLock(b, key);
      expect(lockB).not.toBeNull();
      await lockB?.release();
    } finally {
      a.release();
      b.release();
    }
  });
});
