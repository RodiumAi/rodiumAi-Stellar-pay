import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { db, newId, newPayment } from '../../../packages/db/test/fixtures.js';
import { createAdminQueries } from '../src/queries.js';

// Rows are written as rp_worker; the dashboard reads them as rp_readonly, like production.
const writer = db('worker');
const queries = createAdminQueries(db('readonly'));
const tag = `adm_${randomBytes(4).toString('hex')}`;

async function seed() {
  const paid = newPayment({ merchant_order_id: `${tag}_paid` });
  const open = newPayment({ merchant_order_id: `${tag}_open` });
  await writer.insertInto('payments').values([paid, open]).execute();
  await writer
    .updateTable('payments')
    .set({ status: 'confirmed', confirmed_at: new Date(), amount_received_stroops: 199_900_000n })
    .where('id', '=', paid.id)
    .execute();
  const receipt = {
    id: newId(),
    tx_hash: randomBytes(32),
    item_index: 0,
    ledger: 100,
    ledger_closed_at: new Date(),
    source_address: `G${'C'.repeat(55)}`,
    destination: paid.destination,
    asset_code: 'USDC',
    asset_issuer: paid.asset_issuer,
    amount_stroops: 199_900_000n,
    memo: paid.memo,
  };
  await writer
    .insertInto('chain_receipts')
    .values([
      { ...receipt, match: 'matched', payment_id: paid.id },
      { ...receipt, id: newId(), tx_hash: randomBytes(32), memo: `${tag}_x`, match: 'unmatched' },
    ])
    .execute();
  await writer
    .insertInto('outbox_events')
    .values({
      id: newId(),
      event_type: 'payment.confirmed',
      aggregate_id: paid.id,
      payload: JSON.stringify({ payment_id: paid.id }),
      status: 'dead',
      attempts: 8,
      last_error: 'HTTP 404',
    })
    .execute();
  return { paid, open };
}

describe('admin queries (rp_readonly)', () => {
  it('lists, filters, finds and pages payments', async () => {
    const { paid, open } = await seed();
    const mine = (rows: readonly { merchantOrderId: string }[]) =>
      rows.filter((r) => r.merchantOrderId.startsWith(tag)).map((r) => r.merchantOrderId);

    expect(
      mine(
        await queries.payments({
          status: 'confirmed',
          search: paid.merchant_order_id,
          before: null,
        }),
      ),
    ).toEqual([`${tag}_paid`]);
    expect(mine(await queries.payments({ status: null, search: open.memo, before: null }))).toEqual(
      [`${tag}_open`],
    );
    expect(
      mine(await queries.payments({ status: null, search: paid.id.toUpperCase(), before: null })),
    ).toEqual([`${tag}_paid`]);
    // Pages by id, newest first; `before` the larger id returns the smaller one but not itself.
    // Both were made in the same millisecond, where UUIDv7 order is random, so compare ids.
    const [lower, upper] = [paid, open].sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = mine(
      await queries.payments({ status: null, search: null, before: upper?.id ?? '' }),
    );
    expect(page).toContain(lower?.merchant_order_id);
    expect(page).not.toContain(upper?.merchant_order_id);
  });

  it('loads one payment with its receipts and webhooks', async () => {
    const { paid } = await seed();
    const detail = await queries.payment(paid.id);
    expect(detail?.status).toBe('confirmed');
    expect(detail?.amountReceived).toBe(199_900_000n);
    expect(detail?.receipts).toHaveLength(1);
    expect(detail?.receipts[0]?.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail?.webhooks.map((w) => [w.status, w.lastError])).toEqual([['dead', 'HTTP 404']]);
    expect(await queries.payment('not-a-uuid')).toBeNull();
    expect(await queries.payment(newId())).toBeNull();
  });

  it('lists unmatched receipts and dead webhooks, and counts them', async () => {
    await seed();
    const unmatched = await queries.receipts('unmatched', null);
    expect(unmatched.some((r) => r.memo === `${tag}_x`)).toBe(true);
    expect((await queries.webhooks('dead', null)).length).toBeGreaterThan(0);
    const o = await queries.overview();
    expect(o.receiptsUnmatched).toBeGreaterThan(0);
    expect(o.webhooksDead).toBeGreaterThan(0);
    expect(o.day.confirmed).toBeGreaterThan(0);
    expect(o.day.confirmedVolume).toBeGreaterThanOrEqual(199_900_000n);
    expect(o.recent.length).toBeGreaterThan(0);
  });

  it('cannot change anything (the role is read-only)', async () => {
    const readonly = db('readonly');
    await expect(
      sql`UPDATE payments SET description = 'x' WHERE false`.execute(readonly),
    ).rejects.toThrow();
  });
});
