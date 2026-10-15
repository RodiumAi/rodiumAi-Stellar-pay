import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { db, newId, newPayment, pool, type Role } from './fixtures.js';

// rp_readonly is refused by its read-only default before the privilege check; both are denials.
const PERMISSION_DENIED = /permission denied|read-only transaction/;

async function asRole(role: Role, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  return pool(role, 1).query(sql, params);
}

let paymentId = '';
let receiptId = '';
let auditId = '';

beforeAll(async () => {
  const payment = newPayment();
  paymentId = payment.id;
  await db('api').insertInto('payments').values(payment).execute();
  receiptId = newId();
  await asRole(
    'worker',
    `INSERT INTO chain_receipts (id, tx_hash, item_index, ledger, ledger_closed_at, source_address,
       destination, asset_code, asset_issuer, amount_stroops, memo, match)
     VALUES ($1, $2, 0, 1, now(), 'GSRC', 'GDST', 'USDC', 'GISS', 1, NULL, 'unmatched')`,
    [receiptId, randomBytes(32)],
  );
  auditId = newId();
  await asRole('api', `INSERT INTO audit_log (id, actor, action) VALUES ($1, 'test', 'created')`, [
    auditId,
  ]);
});

describe('roles and privileges (context §7.3)', () => {
  it.each<Role>(['api', 'worker', 'readonly'])(
    '%s cannot UPDATE or DELETE chain_receipts',
    async (role) => {
      await expect(
        asRole(role, `UPDATE chain_receipts SET memo = 'x' WHERE id = $1`, [receiptId]),
      ).rejects.toThrow(PERMISSION_DENIED);
      await expect(
        asRole(role, `DELETE FROM chain_receipts WHERE id = $1`, [receiptId]),
      ).rejects.toThrow(PERMISSION_DENIED);
    },
  );

  it.each<Role>(['api', 'worker', 'readonly'])(
    '%s cannot UPDATE or DELETE audit_log',
    async (role) => {
      await expect(
        asRole(role, `UPDATE audit_log SET action = 'x' WHERE id = $1`, [auditId]),
      ).rejects.toThrow(PERMISSION_DENIED);
      await expect(asRole(role, `DELETE FROM audit_log WHERE id = $1`, [auditId])).rejects.toThrow(
        PERMISSION_DENIED,
      );
    },
  );

  it('rp_api cannot insert receipts or update payments', async () => {
    await expect(
      asRole(
        'api',
        `INSERT INTO chain_receipts (id, tx_hash, item_index, ledger, ledger_closed_at, source_address,
           destination, asset_code, asset_issuer, amount_stroops, match)
         VALUES ($1, $2, 0, 1, now(), 'G', 'G', 'USDC', 'G', 1, 'unmatched')`,
        [newId(), randomBytes(32)],
      ),
    ).rejects.toThrow(PERMISSION_DENIED);
    await expect(
      asRole('api', `UPDATE payments SET status = 'confirmed' WHERE id = $1`, [paymentId]),
    ).rejects.toThrow(PERMISSION_DENIED);
  });

  it('rp_api may only update the allowed subscription columns', async () => {
    await expect(asRole('api', `UPDATE subscriptions SET price_stroops = 1`)).rejects.toThrow(
      PERMISSION_DENIED,
    );
    await expect(
      asRole('api', `UPDATE subscriptions SET status = 'canceled' WHERE false`),
    ).resolves.toBeDefined();
  });

  it('nobody can DELETE payments', async () => {
    for (const role of ['api', 'worker', 'readonly'] as const) {
      await expect(asRole(role, `DELETE FROM payments WHERE id = $1`, [paymentId])).rejects.toThrow(
        PERMISSION_DENIED,
      );
    }
  });

  it('rp_readonly reads but cannot write', async () => {
    const { rows } = await asRole('readonly', `SELECT id FROM payments WHERE id = $1`, [paymentId]);
    expect(rows).toHaveLength(1);
    await expect(
      asRole('readonly', `INSERT INTO audit_log (id, actor, action) VALUES ($1, 'x', 'x')`, [
        newId(),
      ]),
    ).rejects.toThrow(/read-only transaction|permission denied/);
  });

  it.each(['anon', 'authenticated', 'service_role'])(
    '%s sees nothing in pay',
    async (supabaseRole) => {
      const client = new pg.Client({ connectionString: inject('dbUrls').admin });
      await client.connect();
      try {
        await client.query(`SET ROLE ${supabaseRole}`);
        await expect(client.query('SELECT 1 FROM pay.payments LIMIT 1')).rejects.toThrow(
          PERMISSION_DENIED,
        );
      } finally {
        await client.end();
      }
    },
  );

  it('applies per-role timeouts', async () => {
    const { rows } = await asRole(
      'api',
      `SELECT current_setting('statement_timeout') AS t, current_setting('lock_timeout') AS l`,
    );
    expect(rows[0]).toEqual({ t: '5s', l: '3s' });
  });
});
