import { randomBytes } from 'node:crypto';
import type { Stroops } from '@rp/core/money/stroops';
import {
  Account,
  Address,
  Asset,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Memo,
  nativeToScVal,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  guardKeeperTransaction,
  guardPaymentTransaction,
  guardSubscribeTransaction,
  type PaymentRules,
  type SubscribeRules,
} from './xdr-guards.js';

const NOW = 1_760_000_000;
const NET = Networks.TESTNET;
const user = Keypair.random();
const merchant = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const usdc = new Asset('USDC', issuer);
const MEMO = 'RP0123456789AB';
const AMOUNT = 199_900_000n as Stroops;
const contractId = StrKey.encodeContract(randomBytes(32));

interface TxOpts {
  readonly network?: string;
  readonly fee?: string;
  readonly minTime?: number;
  readonly maxTime?: number;
  readonly memo?: Memo;
  readonly signer?: Keypair | null;
  readonly source?: string;
  readonly sorobanData?: xdr.SorobanTransactionData;
}

function build(ops: xdr.Operation[], o: TxOpts = {}): string {
  const builder = new TransactionBuilder(new Account(o.source ?? user.publicKey(), '100'), {
    fee: o.fee ?? '100',
    networkPassphrase: o.network ?? NET,
    timebounds: { minTime: o.minTime ?? 0, maxTime: o.maxTime ?? NOW + 120 },
    ...(o.memo === undefined ? {} : { memo: o.memo }),
  });
  for (const op of ops) builder.addOperation(op);
  if (o.sorobanData !== undefined) builder.setSorobanData(o.sorobanData);
  const tx = builder.build();
  if (o.signer !== null) tx.sign(o.signer ?? user);
  return tx.toXdr();
}

const pay = (overrides: Partial<{ destination: string; asset: Asset; amount: string }> = {}) =>
  Operation.payment({
    destination: overrides.destination ?? merchant,
    asset: overrides.asset ?? usdc,
    amount: overrides.amount ?? '19.9900000',
  });

const paymentRules: PaymentRules = {
  networkPassphrase: NET,
  maxFeeStroops: 100_000n,
  nowSeconds: NOW,
  merchant,
  usdc: { code: 'USDC', issuer },
  amount: AMOUNT,
  memo: MEMO,
};

const goodPayment = (o: TxOpts = {}) => build([pay()], { memo: Memo.text(MEMO), ...o });

describe('guardPaymentTransaction', () => {
  it('accepts exactly the expected payment and returns its hash', () => {
    const result = guardPaymentTransaction(goodPayment(), paymentRules);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, () => string, string]>([
    ['wrong network', () => goodPayment({ network: Networks.PUBLIC }), 'wrong_network_or_unsigned'],
    ['unsigned', () => goodPayment({ signer: null }), 'wrong_network_or_unsigned'],
    [
      'signed by someone else',
      () => goodPayment({ signer: Keypair.random() }),
      'wrong_network_or_unsigned',
    ],
    [
      'extra operation',
      () => build([pay(), pay()], { memo: Memo.text(MEMO) }),
      'wrong_operation_count',
    ],
    [
      'extra non-payment operation',
      () => build([pay(), Operation.bumpSequence({ bumpTo: '999' })], { memo: Memo.text(MEMO) }),
      'wrong_operation_count',
    ],
    [
      'path payment instead of payment',
      () =>
        build(
          [
            Operation.pathPaymentStrictReceive({
              sendAsset: Asset.native(),
              sendMax: '1000',
              destination: merchant,
              destAsset: usdc,
              destAmount: '19.9900000',
              path: [],
            }),
          ],
          { memo: Memo.text(MEMO) },
        ),
      'wrong_operation_type',
    ],
    [
      'wrong destination',
      () => build([pay({ destination: Keypair.random().publicKey() })], { memo: Memo.text(MEMO) }),
      'wrong_destination',
    ],
    [
      'same code, different issuer',
      () =>
        build([pay({ asset: new Asset('USDC', Keypair.random().publicKey()) })], {
          memo: Memo.text(MEMO),
        }),
      'wrong_asset',
    ],
    [
      'native XLM',
      () => build([pay({ asset: Asset.native() })], { memo: Memo.text(MEMO) }),
      'wrong_asset',
    ],
    [
      'different code, same issuer',
      () => build([pay({ asset: new Asset('USDT', issuer) })], { memo: Memo.text(MEMO) }),
      'wrong_asset',
    ],
    [
      'amount too low',
      () => build([pay({ amount: '19.9899999' })], { memo: Memo.text(MEMO) }),
      'wrong_amount',
    ],
    [
      'amount too high',
      () => build([pay({ amount: '19.9900001' })], { memo: Memo.text(MEMO) }),
      'wrong_amount',
    ],
    ['wrong memo', () => build([pay()], { memo: Memo.text('RP0000000000ZZ') }), 'wrong_memo'],
    [
      'memo case differs',
      () => build([pay()], { memo: Memo.text(MEMO.toLowerCase()) }),
      'wrong_memo',
    ],
    ['no memo', () => build([pay()]), 'wrong_memo'],
    ['id memo', () => build([pay()], { memo: Memo.id('42') }), 'wrong_memo'],
    ['no time bounds', () => goodPayment({ maxTime: 0 }), 'missing_time_bounds'],
    ['time bounds > 5 min', () => goodPayment({ maxTime: NOW + 301 }), 'time_bounds_too_long'],
    ['already expired', () => goodPayment({ maxTime: NOW }), 'expired'],
    ['fee over cap', () => goodPayment({ fee: '100001' }), 'fee_too_high'],
    ['garbage', () => 'AAAA', 'malformed_xdr'],
    ['empty', () => '', 'malformed_xdr'],
  ])('rejects %s', (_name, make, error) => {
    expect(guardPaymentTransaction(make(), paymentRules)).toEqual({ ok: false, error });
  });

  it('rejects a fee bump wrapper', () => {
    const inner = TransactionBuilder.fromXdr(goodPayment(), NET);
    if (inner instanceof FeeBumpTransaction) throw new Error('expected a transaction');
    const sponsor = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, '200', inner, NET);
    bump.sign(sponsor);
    expect(guardPaymentTransaction(bump.toXdr(), paymentRules)).toEqual({
      ok: false,
      error: 'fee_bump_not_allowed',
    });
  });

  it('accepts time bounds of exactly 5 minutes', () => {
    expect(guardPaymentTransaction(goodPayment({ maxTime: NOW + 300 }), paymentRules).ok).toBe(
      true,
    );
  });
});

const subscribeOp = (args: xdr.ScVal[], fn = 'subscribe', id = contractId) =>
  new Contract(id).call(fn, ...args);
const subArgs = (o: Partial<{ subscriber: string; plan: number; periods: number }> = {}) => [
  new Address(o.subscriber ?? user.publicKey()).toScVal(),
  nativeToScVal(o.plan ?? 1, { type: 'u32' }),
  nativeToScVal(o.periods ?? 3, { type: 'u32' }),
  nativeToScVal(500_000, { type: 'u32' }),
];

const subscribeRules: SubscribeRules = {
  networkPassphrase: NET,
  maxFeeStroops: 10_000_000n,
  nowSeconds: NOW,
  contractId,
  planId: 1,
  periods: 3,
  subscriber: user.publicKey(),
};

describe('guardSubscribeTransaction', () => {
  it('accepts exactly one subscribe on our contract for the connected wallet', () => {
    expect(guardSubscribeTransaction(build([subscribeOp(subArgs())]), subscribeRules).ok).toBe(
      true,
    );
  });

  it.each<[string, () => string, string]>([
    [
      'wrong network',
      () => build([subscribeOp(subArgs())], { network: Networks.PUBLIC }),
      'wrong_network_or_unsigned',
    ],
    [
      'wrong contract',
      () => build([subscribeOp(subArgs(), 'subscribe', StrKey.encodeContract(randomBytes(32)))]),
      'wrong_contract',
    ],
    ['wrong function', () => build([subscribeOp(subArgs(), 'cancel')]), 'wrong_function'],
    ['wrong plan id', () => build([subscribeOp(subArgs({ plan: 2 }))]), 'wrong_arguments'],
    ['wrong periods', () => build([subscribeOp(subArgs({ periods: 12 }))]), 'wrong_arguments'],
    [
      'wrong subscriber argument',
      () => build([subscribeOp(subArgs({ subscriber: Keypair.random().publicKey() }))]),
      'wrong_arguments',
    ],
    [
      'extra argument',
      () => build([subscribeOp([...subArgs(), nativeToScVal(1, { type: 'u32' })])]),
      'wrong_arguments',
    ],
    ['extra operation', () => build([subscribeOp(subArgs()), pay()]), 'wrong_operation_count'],
    ['plain payment', () => build([pay()]), 'wrong_operation_type'],
    ['fee over cap', () => build([subscribeOp(subArgs())], { fee: '10000001' }), 'fee_too_high'],
    [
      'time bounds > 5 min',
      () => build([subscribeOp(subArgs())], { maxTime: NOW + 3600 }),
      'time_bounds_too_long',
    ],
  ])('rejects %s', (_name, make, error) => {
    expect(guardSubscribeTransaction(make(), subscribeRules)).toEqual({ ok: false, error });
  });

  it('rejects a transaction sourced from another account', () => {
    const other = Keypair.random();
    const xdrStr = build([subscribeOp(subArgs())], { source: other.publicKey(), signer: other });
    expect(guardSubscribeTransaction(xdrStr, subscribeRules)).toEqual({
      ok: false,
      error: 'wrong_source',
    });
  });
});

describe('guardKeeperTransaction', () => {
  const keeper = Keypair.random();
  const rules = {
    networkPassphrase: NET,
    maxFeeStroops: 10_000_000n,
    nowSeconds: NOW,
    contractId,
    keeper: keeper.publicKey(),
  };
  const keeperTx = (ops: xdr.Operation[], o: TxOpts = {}) =>
    build(ops, { source: keeper.publicKey(), signer: null, ...o });
  const charge = (
    id: xdr.ScVal = nativeToScVal(7n, { type: 'u64' }),
    fn = 'charge',
    c = contractId,
  ) => new Contract(c).call(fn, id);
  const ttlData = (keys: xdr.LedgerKey[], readWrite: xdr.LedgerKey[] = []) =>
    new SorobanDataBuilder().setReadOnly(keys).setReadWrite(readWrite).build();
  const ownInstance = new Contract(contractId).getFootprint();
  const foreignInstance = new Contract(StrKey.encodeContract(randomBytes(32))).getFootprint();

  it('accepts charge(sub_id) on our contract from the keeper', () => {
    expect(guardKeeperTransaction(keeperTx([charge()]), rules).ok).toBe(true);
  });

  it('accepts a TTL extension of our own contract entries', () => {
    const tx = keeperTx([Operation.extendFootprintTtl({ extendTo: 500_000 })], {
      sorobanData: ttlData([ownInstance]),
    });
    expect(guardKeeperTransaction(tx, rules).ok).toBe(true);
  });

  it.each<[string, () => string, string]>([
    [
      'non-charge call (cancel)',
      () => keeperTx([charge(nativeToScVal(7n, { type: 'u64' }), 'cancel')]),
      'wrong_function',
    ],
    [
      'set_keeper call',
      () => keeperTx([charge(new Address(keeper.publicKey()).toScVal(), 'set_keeper')]),
      'wrong_function',
    ],
    [
      'wrong contract',
      () => keeperTx([charge(undefined, 'charge', StrKey.encodeContract(randomBytes(32)))]),
      'wrong_contract',
    ],
    ['wrong source', () => build([charge()], { signer: null }), 'wrong_source'],
    ['multiple operations', () => keeperTx([charge(), charge()]), 'wrong_operation_count'],
    [
      'wrong argument type',
      () => keeperTx([charge(nativeToScVal(7, { type: 'u32' }))]),
      'wrong_arguments',
    ],
    ['payment', () => keeperTx([pay()]), 'wrong_operation_type'],
    ['fee over cap', () => keeperTx([charge()], { fee: '10000001' }), 'fee_too_high'],
    [
      'long time bounds',
      () => keeperTx([charge()], { maxTime: NOW + 600 }),
      'time_bounds_too_long',
    ],
    ['no time bounds', () => keeperTx([charge()], { maxTime: 0 }), 'missing_time_bounds'],
    [
      'TTL extension of a foreign contract',
      () =>
        keeperTx([Operation.extendFootprintTtl({ extendTo: 500_000 })], {
          sorobanData: ttlData([ownInstance, foreignInstance]),
        }),
      'foreign_footprint',
    ],
    [
      'TTL extension with read-write footprint',
      () =>
        keeperTx([Operation.extendFootprintTtl({ extendTo: 500_000 })], {
          sorobanData: ttlData([ownInstance], [ownInstance]),
        }),
      'foreign_footprint',
    ],
  ])('refuses %s', (_name, make, error) => {
    expect(guardKeeperTransaction(make(), rules)).toEqual({ ok: false, error });
  });

  it('refuses an operation whose source is another account', () => {
    const op = new Contract(contractId).call('charge', nativeToScVal(7n, { type: 'u64' }));
    const withSource = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contractId).toScAddress(),
          functionName: 'charge',
          args: [nativeToScVal(7n, { type: 'u64' })],
        }),
      ),
      source: Keypair.random().publicKey(),
    });
    expect(op).toBeDefined();
    expect(guardKeeperTransaction(keeperTx([withSource]), rules)).toEqual({
      ok: false,
      error: 'wrong_source',
    });
  });
});
