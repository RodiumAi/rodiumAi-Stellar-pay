import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHorizonSource } from '../src/horizon-source.js';
import type { LedgerSource } from '../src/ledger-source.js';
import { verifyNetwork } from '../src/network-check.js';
import { classifyPayment, type ObservedPayment } from '../src/observed-payment.js';
import { createRpcSource } from '../src/rpc-source.js';

// Local Quickstart (`scripts/stellar-quickstart.sh`), started with core,rpc,horizon.
const BASE = process.env['RP_TEST_STELLAR_URL'] ?? 'http://localhost:8000';
const PASSPHRASE = Networks.STANDALONE;
const MEMO = 'RP0123456789AB';

const horizon = new Horizon.Server(BASE, { allowHttp: true });
const server = new rpc.Server(`${BASE}/rpc`, { allowHttp: true });

const issuer = Keypair.random();
const merchant = Keypair.random();
const payer = Keypair.random();
const usdc = new Asset('USDC', issuer.publicKey());
let startLedger = 0;
let paymentHash = '';

async function fund(kp: Keypair): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${BASE}/friendbot?addr=${kp.publicKey()}`);
    if (res.ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('friendbot did not fund the account');
}

/** Horizon ingests a few seconds behind core; a freshly funded account may 404 briefly. */
async function loadAccount(id: string): Promise<Horizon.AccountResponse> {
  for (let i = 0; ; i++) {
    try {
      return await horizon.loadAccount(id);
    } catch (e) {
      if (i >= 90) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function submit(source: Keypair, ops: xdr.Operation[], memo?: Memo): Promise<string> {
  const account = await loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: PASSPHRASE,
    ...(memo ? { memo } : {}),
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  tx.sign(source);
  const res = await horizon.submitTransaction(tx);
  return res.hash;
}

async function waitFor(source: LedgerSource): Promise<ObservedPayment[]> {
  for (let i = 0; i < 30; i++) {
    const page = await source.fetchPayments({ startLedger }, 200);
    const mine = page.payments.filter((p) => p.txHash === paymentHash);
    if (mine.length > 0) return mine;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${source.name} never reported the payment`);
}

beforeAll(async () => {
  await Promise.all([fund(issuer), fund(merchant), fund(payer)]);
  startLedger = (await server.getLatestLedger()).sequence;
  for (const kp of [merchant, payer]) {
    await submit(kp, [Operation.changeTrust({ asset: usdc })]);
  }
  await submit(issuer, [
    Operation.payment({ destination: payer.publicKey(), asset: usdc, amount: '100' }),
  ]);
  paymentHash = await submit(
    payer,
    [Operation.payment({ destination: merchant.publicKey(), asset: usdc, amount: '19.99' })],
    Memo.text(MEMO),
  );
}, 180_000);

const rules = () => ({
  merchant: merchant.publicKey(),
  usdc: { code: 'USDC', issuer: issuer.publicKey() },
});

describe('against a local Stellar Quickstart', () => {
  it('passes the network passphrase startup check', async () => {
    expect(await verifyNetwork(server, PASSPHRASE)).toEqual({ ok: true, value: undefined });
    expect((await verifyNetwork(server, Networks.TESTNET)).ok).toBe(false);
  });

  it('Horizon source sees the real payment and classifies it eligible', async () => {
    const source = createHorizonSource(BASE, merchant.publicKey(), { fetch });
    const [payment] = await waitFor(source);
    expect(payment).toMatchObject({
      amount: '19.9900000',
      memo: { type: 'text', value: MEMO },
      to: merchant.publicKey(),
    });
    expect(payment && classifyPayment(payment, rules())).toEqual({
      kind: 'eligible',
      amount: 199_900_000n,
      memo: MEMO,
    });
  });

  it('RPC source sees the same payment via CAP-67 transfer events', async () => {
    const source = createRpcSource(
      {
        merchant: merchant.publicKey(),
        usdcContractId: usdc.contractId(PASSPHRASE),
        networkPassphrase: PASSPHRASE,
      },
      server,
    );
    const [payment] = await waitFor(source);
    expect(payment).toMatchObject({
      amount: '19.9900000',
      memo: { type: 'text', value: MEMO },
      viaContract: false,
    });
    expect(payment && classifyPayment(payment, rules())).toEqual({
      kind: 'eligible',
      amount: 199_900_000n,
      memo: MEMO,
    });
  });
});
