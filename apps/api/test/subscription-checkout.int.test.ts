import { randomBytes } from 'node:crypto';
import type { StellarAddress } from '@rp/core/stellar-address';
import { findSubscriptionById } from '@rp/db/subscriptions';
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../packages/db/test/fixtures.js';
import type { CheckoutDeps } from '../src/checkout/routes.js';
import { appConfig, harness, signed, type Harness } from './harness.js';

const contractId = StrKey.encodeContract(randomBytes(32));
const app = {
  ...appConfig,
  network: {
    ...appConfig.network,
    merchant: Keypair.random().publicKey() as StellarAddress,
    subscriptionContractId: contractId,
  },
};
const user = Keypair.random();
let sent = 0;
let nextSubId = 41n;

const soroban: CheckoutDeps['soroban'] = {
  getAccount: (a) => Promise.resolve(new Account(a, '1')),
  getLatestLedger: () => Promise.reject(new Error('unused')),
  getLedgerEntries: () => Promise.reject(new Error('simulation unavailable in tests')),
  prepareTransaction: () => Promise.reject(new Error('unused')),
  simulateTransaction: () => Promise.reject(new Error('unused')),
  sendTransaction: () => {
    sent += 1;
    return Promise.resolve({
      status: 'PENDING',
      hash: randomBytes(32).toString('hex'),
      latestLedger: 1,
      latestLedgerCloseTime: 0,
    } as rpc.Api.SendTransactionResponse);
  },
  getTransaction: () =>
    Promise.resolve({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: nativeToScVal(nextSubId, { type: 'u64' }),
    } as unknown as rpc.Api.GetTransactionResponse),
};

const checkout: CheckoutDeps = {
  assets: { page: { script: '/c/assets/main.js', styles: [] }, files: new Map() },
  horizonFetch: () => Promise.reject(new Error('unused')),
  soroban,
};

let h: Harness;
beforeAll(async () => {
  h = await harness({}, app, checkout);
});

async function createSubscription(): Promise<{ id: string; token: string }> {
  const res = await h.server.inject(
    signed('POST', '/v1/subscriptions', {
      merchant_subscription_ref: 'sub_c',
      customer_ref: 'usr_c',
      plan_code: 'pro_monthly',
      return_url: 'https://app.rodium.test/billing/return',
    }),
  );
  const body = JSON.parse(res.body) as { id: string; checkout_url: string };
  return { id: body.id, token: body.checkout_url.split('/c/')[1] ?? '' };
}

function subscribeXdr(
  o: {
    plan?: number;
    periods?: number;
    contract?: string;
    signer?: Keypair;
    liveUntil?: number;
  } = {},
): string {
  const kp = o.signer ?? user;
  const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: '100000',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 120 },
  })
    .addOperation(
      new Contract(o.contract ?? contractId).call(
        'subscribe',
        new Address(kp.publicKey()).toScVal(),
        nativeToScVal(o.plan ?? 1, { type: 'u32' }),
        nativeToScVal(o.periods ?? 3, { type: 'u32' }),
        nativeToScVal(o.liveUntil ?? 777_777, { type: 'u32' }),
      ),
    )
    .build();
  tx.sign(kp);
  return tx.toXdr();
}

describe('subscription checkout (context §11.1)', () => {
  it('renders the plan, price and approval terms', async () => {
    const { token } = await createSubscription();
    const res = await h.server.inject({ method: 'GET', url: `/c/${token}` });
    expect(res.statusCode).toBe(200);
    const doc = new JSDOM(res.body).window.document;
    expect(doc.querySelector('.amount')?.textContent).toBe('9.9900000 USDC every 30 days');
    expect(doc.body.textContent).toContain('Up to 3 future charges of 9.9900000 USDC');
    expect(doc.body.textContent).toContain(contractId);
    expect(doc.getElementById('pay-freighter')?.textContent).toBe('Subscribe with Freighter');
    expect(res.headers['content-security-policy']).toContain("'nonce-");
  });

  it('a failed simulation returns a friendly 400', async () => {
    const { token } = await createSubscription();
    const res = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/prepare`,
      payload: { address: user.publicKey() },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it.each<[string, () => string]>([
    ['the wrong plan', () => subscribeXdr({ plan: 2 })],
    ['the wrong period count', () => subscribeXdr({ periods: 12 })],
    ['another contract', () => subscribeXdr({ contract: StrKey.encodeContract(randomBytes(32)) })],
    ['garbage', () => 'AAAA'],
  ])('rejects %s with 422', async (_n, make) => {
    const { token } = await createSubscription();
    const before = sent;
    const res = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/submit`,
      payload: { xdr: make() },
    });
    expect(res.statusCode).toBe(422);
    expect(sent).toBe(before);
  });

  it('activates with the on-chain id and allowance, emits subscription.activated once', async () => {
    const { id, token } = await createSubscription();
    nextSubId += 1n;
    const xdr = subscribeXdr({ liveUntil: 888_888 });
    const res = await h.server.inject({
      method: 'POST',
      url: `/c/${token}/submit`,
      payload: { xdr },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'active' });
    expect(await findSubscriptionById(db('worker'), id)).toMatchObject({
      status: 'active',
      subscriber_address: user.publicKey(),
      contract_subscription_id: nextSubId,
      allowance_expires_ledger: 888_888,
    });
    const events = await db('worker')
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', id)
      .execute();
    expect(events).toEqual([expect.objectContaining({ event_type: 'subscription.activated' })]);
    expect(
      (await h.server.inject({ method: 'POST', url: `/c/${token}/submit`, payload: { xdr } }))
        .statusCode,
    ).toBe(409);
    expect((await h.server.inject({ method: 'GET', url: `/c/${token}` })).statusCode).toBe(404);
    const status = JSON.parse(
      (await h.server.inject({ method: 'GET', url: `/c/${token}/status` })).body,
    ) as { status: string; final: boolean };
    expect(status).toMatchObject({ status: 'active', final: true });
  });
});
