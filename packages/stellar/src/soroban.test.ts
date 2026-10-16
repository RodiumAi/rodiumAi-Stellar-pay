import { randomBytes } from 'node:crypto';
import {
  Account,
  Keypair,
  Networks,
  type rpc,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { guardKeeperTransaction } from './xdr-guards.js';
import { prepareExtendTtl, type SorobanClient } from './soroban.js';

const contractId = StrKey.encodeContract(randomBytes(32));
const keeper = Keypair.random().publicKey();

function footprintOf(tx: Transaction): xdr.LedgerKey[] {
  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') return [];
  const ext = envelope.v1.tx.ext;
  return ext.type === 'sorobanData' ? ext.sorobanData.resources.footprint.readOnly : [];
}

function client(footprint: 'echo' | 'empty'): SorobanClient {
  const fail = () => Promise.reject(new Error('unused'));
  return {
    getAccount: (a) => Promise.resolve(new Account(a, '1')),
    sendTransaction: fail,
    getTransaction: fail,
    simulateTransaction: (tx) => {
      const keys = footprintOf(tx);
      return Promise.resolve({
        _parsed: true,
        id: 'sim',
        latestLedger: 1,
        events: [],
        minResourceFee: '500',
        transactionData: new SorobanDataBuilder().setReadOnly(footprint === 'echo' ? keys : []),
      } as unknown as rpc.Api.SimulateTransactionResponse);
    },
  };
}

const params = {
  contractId,
  keeper,
  subIds: [1n, 2n],
  extendToLedgers: 3_000_000,
  networkPassphrase: Networks.TESTNET,
  baseFee: '1000',
  timeoutSeconds: 120,
};

describe('prepareExtendTtl', () => {
  it('builds an extension the keeper guard accepts', async () => {
    const r = await prepareExtendTtl(client('echo'), params);
    expect(r.ok && r.value !== null).toBe(true);
    if (!r.ok || r.value === null) return;
    const guarded = guardKeeperTransaction(r.value, {
      contractId,
      keeper,
      networkPassphrase: Networks.TESTNET,
      maxFeeStroops: 20_000_000n,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(guarded.ok).toBe(true);
  });

  it('returns null when RPC reports nothing to extend (empty footprint)', async () => {
    expect(await prepareExtendTtl(client('empty'), params)).toEqual({ ok: true, value: null });
  });

  it('lists the instance and each subscription in the footprint', async () => {
    const r = await prepareExtendTtl(client('echo'), params);
    if (!r.ok || r.value === null) throw new Error('expected a transaction');
    const tx = TransactionBuilder.fromXdr(r.value, Networks.TESTNET) as Transaction;
    expect(footprintOf(tx)).toHaveLength(3);
  });
});
