import { randomBytes } from 'node:crypto';
import type { Stroops } from '@rp/core/money/stroops';
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Memo,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { parseSubscriptionEvent } from './contract-events.js';
import { createHorizonSource, fromHorizonRecord } from './horizon-source.js';
import { verifyNetwork } from './network-check.js';
import { classifyPayment, type ObservedPayment } from './observed-payment.js';
import { createRpcSource, type RpcClient } from './rpc-source.js';
import { buildPayUri } from './sep7.js';
import { computeLiveUntilLedger } from './subscribe-tx.js';

const merchant = Keypair.random().publicKey();
const payer = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const rules = { merchant, usdc: { code: 'USDC', issuer } };
const HASH = 'a'.repeat(64);

function horizonRecord(overrides: Record<string, unknown> = {}, tx: Record<string, unknown> = {}) {
  return {
    id: '4294967297',
    paging_token: '4294967297',
    transaction_hash: HASH,
    transaction_successful: true,
    created_at: '2026-10-15T12:00:00Z',
    type: 'payment',
    from: payer,
    to: merchant,
    amount: '19.9900000',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: issuer,
    transaction: {
      memo_type: 'text',
      memo: 'RP0123456789AB',
      ledger: 1234,
      successful: true,
      ...tx,
    },
    ...overrides,
  };
}

const classify = (raw: unknown) =>
  fromHorizonRecord(raw, merchant).map((p) => classifyPayment(p, rules));

describe('Horizon records → classification (context §13.2)', () => {
  it('plain USDC payment with memo is eligible', () => {
    expect(classify(horizonRecord())).toEqual([
      { kind: 'eligible', amount: 199_900_000n, memo: 'RP0123456789AB' },
    ]);
    expect(fromHorizonRecord(horizonRecord(), merchant)[0]).toMatchObject({
      itemIndex: 0,
      ledger: 1234,
      cursor: '4294967297',
    });
  });

  it.each(['path_payment_strict_send', 'path_payment_strict_receive'])(
    '%s counts the amount received',
    (type) => {
      const raw = horizonRecord({
        type,
        amount: '5.0000000',
        source_amount: '9.1000000',
        source_asset_type: 'native',
      });
      expect(classify(raw)).toEqual([
        { kind: 'eligible', amount: 50_000_000n, memo: 'RP0123456789AB' },
      ]);
    },
  );

  it('missing memo is eligible with a null memo (matching stores it as unmatched)', () => {
    expect(classify(horizonRecord({}, { memo_type: 'none', memo: undefined }))).toEqual([
      { kind: 'eligible', amount: 199_900_000n, memo: null },
    ]);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, unknown]>([
    [
      'wrong asset (same code, other issuer)',
      { asset_issuer: Keypair.random().publicKey() },
      {},
      { kind: 'unmatched', reason: 'wrong_asset', amount: 199_900_000n },
    ],
    [
      'native XLM',
      { asset_type: 'native', asset_code: undefined, asset_issuer: undefined },
      {},
      { kind: 'unmatched', reason: 'wrong_asset', amount: 199_900_000n },
    ],
    [
      'native XLM dust (address poisoning)',
      { asset_type: 'native', asset_code: undefined, asset_issuer: undefined, amount: '0.0001000' },
      {},
      { kind: 'ignored', reason: 'dust' },
    ],
    [
      'native XLM at the dust limit',
      { asset_type: 'native', asset_code: undefined, asset_issuer: undefined, amount: '0.1000000' },
      {},
      { kind: 'unmatched', reason: 'wrong_asset', amount: 1_000_000n },
    ],
    [
      'tiny USDC is never dust',
      { amount: '0.0000001' },
      {},
      { kind: 'eligible', amount: 1n, memo: 'RP0123456789AB' },
    ],
    [
      'id memo',
      {},
      { memo_type: 'id', memo: '42' },
      { kind: 'unmatched', reason: 'non_text_memo', amount: 199_900_000n },
    ],
    [
      'outgoing payment',
      { from: merchant, to: payer },
      {},
      { kind: 'ignored', reason: 'not_to_merchant' },
    ],
    [
      'failed transaction',
      { transaction_successful: false },
      { successful: false },
      { kind: 'ignored', reason: 'failed' },
    ],
  ])('%s', (_name, overrides, tx, expected) => {
    expect(classify(horizonRecord(overrides, tx))).toEqual([expected]);
  });

  it('create_account into the merchant is native → unmatched', () => {
    const raw = horizonRecord({
      type: 'create_account',
      funder: payer,
      account: merchant,
      starting_balance: '10.0000000',
    });
    expect(classify(raw)).toEqual([
      { kind: 'unmatched', reason: 'wrong_asset', amount: 100_000_000n },
    ]);
  });

  it('subscription charges (invoke_host_function) are ignored for payment matching', () => {
    const raw = horizonRecord({
      type: 'invoke_host_function',
      asset_balance_changes: [
        {
          type: 'transfer',
          from: payer,
          to: merchant,
          amount: '9.9900000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: issuer,
        },
        { type: 'transfer', from: payer, to: payer, amount: '1.0000000', asset_type: 'native' },
      ],
    });
    expect(classify(raw)).toEqual([{ kind: 'ignored', reason: 'contract_transfer' }]);
  });

  it('account_merge and unknown types yield no credits', () => {
    expect(
      fromHorizonRecord(
        horizonRecord({ type: 'account_merge', account: payer, into: merchant }),
        merchant,
      ),
    ).toEqual([]);
  });

  it('rejects malformed records instead of guessing', () => {
    expect(() => fromHorizonRecord({ id: '1' }, merchant)).toThrow();
    expect(() => fromHorizonRecord(horizonRecord({ transaction_hash: 'zz' }), merchant)).toThrow();
  });

  it('derives the operation index from the TOID', () => {
    const third = (BigInt(1234) << 32n) | 3n;
    expect(fromHorizonRecord(horizonRecord({ id: third.toString() }), merchant)[0]?.itemIndex).toBe(
      2,
    );
  });
});

describe('createHorizonSource', () => {
  it('pages ascending from the cursor with joined transactions', async () => {
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith('/')
              ? { history_latest_ledger: 1300 }
              : { _embedded: { records: [horizonRecord()] } },
          ),
        ),
      ),
    );
    const source = createHorizonSource('https://horizon.example/', merchant, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const page = await source.fetchPayments({ cursor: 'now-1' }, 50);
    const called = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(called.pathname).toBe(`/accounts/${merchant}/payments`);
    expect(Object.fromEntries(called.searchParams)).toMatchObject({
      cursor: 'now-1',
      order: 'asc',
      join: 'transactions',
      limit: '50',
    });
    expect(page).toMatchObject({ cursor: '4294967297', latestLedger: 1300 });
    expect(page.payments).toHaveLength(1);
  });

  it('converts a start ledger to a TOID cursor and keeps the cursor when empty', async () => {
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith('/') ? { history_latest_ledger: 9 } : { _embedded: { records: [] } },
          ),
        ),
      ),
    );
    const source = createHorizonSource('https://horizon.example', merchant, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const page = await source.fetchPayments({ startLedger: 10 }, 10);
    expect(page.cursor).toBe((10n << 32n).toString());
  });

  it('fails loudly on HTTP errors', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('nope', { status: 503 })));
    const source = createHorizonSource('https://horizon.example', merchant, {
      fetch: fetch,
    });
    await expect(source.fetchPayments({ cursor: '1' }, 10)).rejects.toThrow('HTTP 503');
  });
});

describe('createRpcSource (CAP-67 transfer events)', () => {
  const usdcContractId = StrKey.encodeContract(randomBytes(32));
  const user = Keypair.random();

  function envelope(
    ops: xdr.Operation[],
    memo: Memo = Memo.text('RP0123456789AB'),
  ): xdr.TransactionEnvelope {
    return new TransactionBuilder(new Account(user.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      memo,
    })
      .addOperation(ops[0] ?? Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(0)
      .build()
      .toEnvelope();
  }

  function transferEvent(
    amount: xdr.ScVal,
    overrides: Partial<rpc.Api.EventResponse> = {},
  ): rpc.Api.EventResponse {
    return {
      id: '0000005000-0000000001',
      type: 'contract',
      ledger: 5000,
      ledgerClosedAt: '2026-10-15T12:00:00Z',
      transactionIndex: 1,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      txHash: HASH,
      contractId: new Contract(usdcContractId),
      topic: [
        nativeToScVal('transfer', { type: 'symbol' }),
        new Address(user.publicKey()).toScVal(),
        new Address(merchant).toScVal(),
        nativeToScVal(`USDC:${issuer}`),
      ],
      value: amount,
      ...overrides,
    };
  }

  function client(
    events: rpc.Api.EventResponse[],
    env: xdr.TransactionEnvelope,
  ): RpcClient & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      getEvents: (req) => {
        calls.push(req);
        return Promise.resolve({
          events,
          cursor: 'next-cursor',
          latestLedger: 5010,
          oldestLedger: 1,
          latestLedgerCloseTime: '',
          oldestLedgerCloseTime: '',
        });
      },
      getTransaction: () =>
        Promise.resolve({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          envelopeXdr: env,
        } as unknown as rpc.Api.GetTransactionResponse),
    };
  }

  const config = { merchant, usdcContractId, networkPassphrase: Networks.TESTNET };

  it('maps a classic payment transfer with its memo', async () => {
    const c = client(
      [transferEvent(nativeToScVal(199_900_000n, { type: 'i128' }))],
      envelope([
        Operation.payment({
          destination: merchant,
          asset: new Asset('USDC', issuer),
          amount: '19.99',
        }),
      ]),
    );
    const page = await createRpcSource(config, c).fetchPayments({ startLedger: 4000 }, 100);
    expect(page).toMatchObject({ cursor: 'next-cursor', latestLedger: 5010 });
    const [p] = page.payments as ObservedPayment[];
    expect(p).toMatchObject({
      txHash: HASH,
      itemIndex: 0,
      ledger: 5000,
      amount: '19.9900000',
      memo: { type: 'text', value: 'RP0123456789AB' },
      viaContract: false,
    });
    expect(p && classifyPayment(p, rules)).toEqual({
      kind: 'eligible',
      amount: 199_900_000n as Stroops,
      memo: 'RP0123456789AB',
    });
    expect(c.calls[0]).toMatchObject({ startLedger: 4000, limit: 100 });
  });

  it('reads the amount from the muxed map form', async () => {
    const value = nativeToScVal(
      { amount: 5n, to_muxed_id: 9n },
      { type: { amount: ['symbol', 'i128'], to_muxed_id: ['symbol', 'u64'] } },
    );
    const c = client([transferEvent(value)], envelope([]));
    const [p] = (await createRpcSource(config, c).fetchPayments({ cursor: 'x' }, 10)).payments;
    expect(p?.amount).toBe('0.0000005');
  });

  it('flags transfers from contract calls (subscription charges)', async () => {
    const invoke = new Contract(StrKey.encodeContract(randomBytes(32))).call(
      'charge',
      nativeToScVal(1n, { type: 'u64' }),
    );
    const c = client([transferEvent(nativeToScVal(1n, { type: 'i128' }))], envelope([invoke]));
    const [p] = (await createRpcSource(config, c).fetchPayments({ cursor: 'x' }, 10)).payments;
    expect(p && classifyPayment(p, rules)).toEqual({
      kind: 'ignored',
      reason: 'contract_transfer',
    });
  });
});

describe('parseSubscriptionEvent', () => {
  const contractId = StrKey.encodeContract(randomBytes(32));
  const subscriber = Keypair.random().publicKey();
  const event = (name: string, value: xdr.ScVal, id = contractId): rpc.Api.EventResponse => ({
    id: 'evt-1',
    type: 'contract',
    ledger: 77,
    ledgerClosedAt: '2026-10-15T12:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: HASH,
    contractId: new Contract(id),
    topic: [nativeToScVal(name, { type: 'symbol' }), nativeToScVal(3n, { type: 'u64' })],
    value,
  });

  it('parses sub_created, charged and canceled', () => {
    const created = nativeToScVal(
      {
        subscriber: new Address(subscriber),
        plan_id: 1,
        price: 99_900_000n,
        next_charge_at: 1_760_000_000n,
      },
      {
        type: {
          subscriber: ['symbol', 'address'],
          plan_id: ['symbol', 'u32'],
          price: ['symbol', 'i128'],
          next_charge_at: ['symbol', 'u64'],
        },
      },
    );
    expect(parseSubscriptionEvent(event('sub_created', created), contractId)?.event).toEqual({
      type: 'sub_created',
      subId: 3n,
      subscriber,
      planId: 1,
      price: 99_900_000n,
      nextChargeAt: 1_760_000_000n,
    });
    const charged = nativeToScVal(
      { amount: 5n, next_charge_at: 9n },
      { type: { amount: ['symbol', 'i128'], next_charge_at: ['symbol', 'u64'] } },
    );
    expect(parseSubscriptionEvent(event('charged', charged), contractId)?.event).toEqual({
      type: 'charged',
      subId: 3n,
      amount: 5n,
      nextChargeAt: 9n,
    });
    const canceled = nativeToScVal(
      { by: new Address(subscriber) },
      { type: { by: ['symbol', 'address'] } },
    );
    expect(parseSubscriptionEvent(event('canceled', canceled), contractId)).toMatchObject({
      event: { type: 'canceled', subId: 3n, by: subscriber },
      ledger: 77,
    });
  });

  it('ignores other contracts, unknown names and malformed data', () => {
    const v = nativeToScVal(
      { by: new Address(subscriber) },
      { type: { by: ['symbol', 'address'] } },
    );
    expect(
      parseSubscriptionEvent(
        event('canceled', v, StrKey.encodeContract(randomBytes(32))),
        contractId,
      ),
    ).toBeNull();
    expect(parseSubscriptionEvent(event('plan_set', v), contractId)).toBeNull();
    expect(parseSubscriptionEvent(event('charged', v), contractId)).toBeNull();
  });
});

describe('buildPayUri (SEP-7)', () => {
  const base = {
    destination: merchant,
    amount: 199_900_000n as Stroops,
    assetCode: 'USDC',
    assetIssuer: issuer,
    memo: 'RP0123456789AB',
  };

  it('builds a testnet pay URI with the network passphrase', () => {
    const uri = buildPayUri({ ...base, networkPassphrase: Networks.TESTNET, message: 'Pro plan' });
    const params = new URLSearchParams(uri.replace('web+stellar:pay?', ''));
    expect(uri.startsWith('web+stellar:pay?')).toBe(true);
    expect(Object.fromEntries(params)).toEqual({
      destination: merchant,
      amount: '19.9900000',
      asset_code: 'USDC',
      asset_issuer: issuer,
      memo: 'RP0123456789AB',
      memo_type: 'MEMO_TEXT',
      network_passphrase: Networks.TESTNET,
      msg: 'Pro plan',
    });
    expect(uri.split('?')[1]).not.toContain('+');
    expect(uri).toContain('network_passphrase=Test%20SDF%20Network');
  });

  it('omits the passphrase on mainnet', () => {
    expect(buildPayUri({ ...base, networkPassphrase: Networks.PUBLIC })).not.toContain(
      'network_passphrase',
    );
  });
});

describe('verifyNetwork', () => {
  it('passes on the configured passphrase and fails on any other', async () => {
    const client = (passphrase: string) => ({ getNetwork: () => Promise.resolve({ passphrase }) });
    expect(await verifyNetwork(client(Networks.TESTNET), Networks.TESTNET)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await verifyNetwork(client(Networks.PUBLIC), Networks.TESTNET)).toEqual({
      ok: false,
      error: { code: 'network_mismatch', reported: Networks.PUBLIC },
    });
  });
});

describe('computeLiveUntilLedger', () => {
  it('covers all periods plus a buffer', () => {
    expect(
      computeLiveUntilLedger({
        latestLedger: 1000,
        maxEntryTtl: 3_110_400,
        periods: 3,
        intervalSeconds: 30 * 86_400,
      }),
    ).toEqual({
      liveUntilLedger: 1000 + 3 * 518_400 + 17_280,
      cappedByNetwork: false,
    });
  });

  it('is capped by the network max TTL', () => {
    expect(
      computeLiveUntilLedger({
        latestLedger: 1000,
        maxEntryTtl: 100_000,
        periods: 12,
        intervalSeconds: 30 * 86_400,
      }),
    ).toEqual({
      liveUntilLedger: 1000 + 99_999,
      cappedByNetwork: true,
    });
  });
});
