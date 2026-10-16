import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StellarAddress } from '@rp/core/stellar-address';
import { cryptoRandomBytes } from '@rp/core/random';
import { findPaymentById } from '@rp/db/payments';
import { verifyWebhook } from '@rp/security/webhook-signature';
import { createHorizonSource } from '@rp/stellar/horizon-source';
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../../../packages/db/test/fixtures.js';
import { appConfig, harness, paymentBody, signed } from '../../api/test/harness.js';
import { createDispatchJob } from '../src/jobs/dispatch.js';
import { createIngestJob } from '../src/jobs/ingest.js';
import { createMetrics } from '../src/metrics.js';

// Context §19 / plan S7: API → real USDC payment on a local Quickstart → worker → signed webhook.
const BASE = process.env['RP_TEST_STELLAR_URL'] ?? 'http://localhost:8000';
const PASSPHRASE = Networks.STANDALONE;
const horizon = new Horizon.Server(BASE, { allowHttp: true });
const issuer = Keypair.random();
const merchant = Keypair.random();
const payer = Keypair.random();
const usdc = new Asset('USDC', issuer.publicKey());
const never = new AbortController().signal;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function fund(kp: Keypair): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${BASE}/friendbot?addr=${kp.publicKey()}`)).ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('friendbot did not fund');
}

async function submit(source: Keypair, op: xdr.Operation, memo?: Memo): Promise<string> {
  let account: Horizon.AccountResponse | undefined;
  for (let i = 0; account === undefined; i++) {
    try {
      account = await horizon.loadAccount(source.publicKey());
    } catch (e) {
      if (i > 90) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const tx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: PASSPHRASE,
    ...(memo ? { memo } : {}),
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx.sign(source);
  return (await horizon.submitTransaction(tx)).hash;
}

const webhookKeys = generateKeyPairSync('ed25519');
const received: { signature: string; body: Buffer }[] = [];
let receiver: Server;
let webhookUrl = '';
let startLedger = 0;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        signature: String(req.headers['rp-signature']),
        body: Buffer.concat(chunks),
      });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  webhookUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/webhooks/crypto`;

  await Promise.all([fund(issuer), fund(merchant), fund(payer)]);
  for (const kp of [merchant, payer]) await submit(kp, Operation.changeTrust({ asset: usdc }));
  await submit(
    issuer,
    Operation.payment({ destination: payer.publicKey(), asset: usdc, amount: '100' }),
  );
  startLedger = (await horizon.ledgers().order('desc').limit(1).call()).records[0]?.sequence ?? 1;
}, 300_000);

afterAll(() => {
  receiver.close();
});

describe('end to end on Quickstart', () => {
  it('create payment via API → pay USDC with memo → confirmed → signed payment.confirmed webhook', async () => {
    const app = {
      ...appConfig,
      network: {
        ...appConfig.network,
        passphrase: PASSPHRASE,
        horizonUrl: BASE,
        merchant: merchant.publicKey() as StellarAddress,
        usdc: {
          code: 'USDC' as const,
          issuer: issuer.publicKey() as StellarAddress,
          contractId: usdc.contractId(PASSPHRASE),
        },
      },
    };
    const api = await harness({}, app);
    const created = await api.server.inject(
      signed(
        'POST',
        '/v1/payments',
        paymentBody({ amount: { currency: 'USD', value_minor: 1999 } }),
      ),
    );
    expect(created.statusCode).toBe(201);
    const paymentId = (JSON.parse(created.body) as { id: string }).id;
    const row = await findPaymentById(db('worker'), paymentId);
    if (row === undefined) throw new Error('payment missing');
    expect(row.destination).toBe(merchant.publicKey());

    const txHash = await submit(
      payer,
      Operation.payment({ destination: merchant.publicKey(), asset: usdc, amount: '19.99' }),
      Memo.text(row.memo),
    );

    const worker = db('worker', 5);
    const metrics = createMetrics();
    const ingest = createIngestJob({
      db: worker,
      sessionPool: pool('worker', 1),
      source: createHorizonSource(BASE, merchant.publicKey(), { fetch }),
      rules: { merchant: merchant.publicKey(), usdc: { code: 'USDC', issuer: issuer.publicKey() } },
      startLedger,
      metrics,
      logger: silent,
    });
    for (
      let i = 0;
      i < 60 && (await findPaymentById(worker, paymentId))?.status !== 'confirmed';
      i++
    ) {
      await ingest.run(never);
      await new Promise((r) => setTimeout(r, 1000));
    }
    await ingest.release();
    expect(await findPaymentById(worker, paymentId)).toMatchObject({
      status: 'confirmed',
      amount_received_stroops: 199_900_000n,
    });

    await createDispatchJob({
      db: worker,
      url: webhookUrl,
      signer: { keyId: 'whk_e2e', privateKey: webhookKeys.privateKey },
      fetch,
      now: () => new Date(),
      randomBytes: cryptoRandomBytes,
      metrics,
      logger: silent,
    }).run(never);

    const hook = received
      .map((r) => ({
        ...r,
        json: JSON.parse(r.body.toString()) as {
          type: string;
          data: { payment_id: string; tx_hashes: string[] };
        },
      }))
      .find((r) => r.json.data.payment_id === paymentId);
    if (hook === undefined) throw new Error('webhook not received');
    expect(hook.json).toMatchObject({
      type: 'payment.confirmed',
      data: { amount_due: '19.9900000', amount_received: '19.9900000', tx_hashes: [txHash] },
    });
    const verified = verifyWebhook(
      (k) => (k === 'whk_e2e' ? webhookKeys.publicKey : undefined),
      hook.signature,
      hook.body,
      Math.floor(Date.now() / 1000),
    );
    expect(verified.ok).toBe(true);
  });
});
