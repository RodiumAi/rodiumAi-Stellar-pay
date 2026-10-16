import { randomBytes } from 'node:crypto';
import { err, ok } from '@rp/core/result';
import { cryptoRandomBytes } from '@rp/core/random';
import { DAY } from '@rp/core/time';
import { findSubscriptionById, insertSubscription } from '@rp/db/subscriptions';
import type { SorobanClient } from '@rp/stellar/soroban';
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { db, newId, newSubscription } from '../../../packages/db/test/fixtures.js';
import { createChargeJob } from '../src/jobs/charge.js';
import { createContractEventsJob, type ContractEventsClient } from '../src/jobs/contract-events.js';
import { createAllowanceWarningJob } from '../src/jobs/maintenance.js';
import { createMetrics } from '../src/metrics.js';
import type { SignerClient } from '../src/signer-client.js';

const worker = db('worker', 10);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const never = new AbortController().signal;
const keeper = Keypair.random().publicKey();
const contractId = StrKey.encodeContract(randomBytes(32));
let contractSeq = 10_000n;

async function activeSubscription(nextChargeAt: Date, overrides: Record<string, unknown> = {}) {
  const created = await insertSubscription(db('api'), newSubscription());
  if (!created.ok) throw new Error(created.error);
  contractSeq += 1n;
  await worker
    .updateTable('subscriptions')
    .set({
      status: 'active',
      subscriber_address: Keypair.random().publicKey(),
      contract_subscription_id: contractSeq,
      next_charge_at: nextChargeAt,
      current_period_end: nextChargeAt,
      allowance_expires_ledger: 9_999_999,
      ...overrides,
    })
    .where('id', '=', created.value.row.id)
    .execute();
  const row = await findSubscriptionById(worker, created.value.row.id);
  if (row === undefined) throw new Error('missing');
  return row;
}

interface FakeChain extends SorobanClient {
  simulateError: string | null;
  /** What `get(sub_id)` reports on-chain (unix seconds); null → due now. */
  onChainNext: bigint | null;
  sent: number;
  nextChargeAt: bigint;
}

function fakeChain(): FakeChain {
  const chain: FakeChain = {
    simulateError: null,
    onChainNext: null,
    sent: 0,
    nextChargeAt: 0n,
    getAccount: (address) => Promise.resolve(new Account(address, '1')),
    simulateTransaction: (tx) => {
      const op = tx.operations[0];
      const fn =
        op?.type === 'invokeHostFunction' && op.func.type === 'hostFunctionTypeInvokeContract'
          ? op.func.invokeContract.functionName.toString()
          : '';
      if (fn === 'get') {
        const next = chain.onChainNext ?? BigInt(Math.floor(Date.now() / 1000) - 60);
        return Promise.resolve({
          _parsed: true,
          id: 'sim',
          latestLedger: 100,
          events: [],
          minResourceFee: '0',
          transactionData: new SorobanDataBuilder(),
          result: {
            auth: [],
            retval: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({
                key: nativeToScVal('next_charge_at', { type: 'symbol' }),
                val: nativeToScVal(next, { type: 'u64' }),
              }),
              new xdr.ScMapEntry({
                key: nativeToScVal('status', { type: 'symbol' }),
                val: xdr.ScVal.scvVec([nativeToScVal('Active', { type: 'symbol' })]),
              }),
            ]),
          },
        } as unknown as rpc.Api.SimulateTransactionResponse);
      }
      return Promise.resolve(
        (chain.simulateError === null
          ? {
              _parsed: true,
              id: 'sim',
              latestLedger: 100,
              events: [],
              minResourceFee: '1000',
              transactionData: new SorobanDataBuilder(),
              result: { auth: [], retval: xdr.ScVal.scvVoid() },
            }
          : {
              _parsed: true,
              id: 'sim',
              latestLedger: 100,
              events: [],
              error: chain.simulateError,
            }) as unknown as rpc.Api.SimulateTransactionResponse,
      );
    },
    sendTransaction: () => {
      chain.sent += 1;
      return Promise.resolve({
        status: 'PENDING',
        hash: randomBytes(32).toString('hex'),
        latestLedger: 100,
        latestLedgerCloseTime: 0,
      } as rpc.Api.SendTransactionResponse);
    },
    getTransaction: () =>
      Promise.resolve({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        returnValue: nativeToScVal(
          { sub_id: 1n, amount: 99_900_000n, next_charge_at: chain.nextChargeAt },
          {
            type: {
              sub_id: ['symbol', 'u64'],
              amount: ['symbol', 'i128'],
              next_charge_at: ['symbol', 'u64'],
            },
          },
        ),
      } as unknown as rpc.Api.GetTransactionResponse),
  };
  return chain;
}

const okSigner: SignerClient = { sign: (x) => Promise.resolve(ok(x)) };

function chargeJob(chain: FakeChain, now: () => Date, signer: SignerClient = okSigner) {
  const metrics = createMetrics();
  return {
    metrics,
    job: createChargeJob({
      db: worker,
      chain,
      signer,
      keeper,
      contractId,
      networkPassphrase: 'Test SDF Network ; September 2015',
      maxFeeStroops: 10_000_000n,
      now,
      randomBytes: cryptoRandomBytes,
      metrics,
      logger: silent,
      // Other files leave due subscriptions in the shared test DB; claim them all.
      batchSize: 10_000,
    }),
  };
}

const charges = (subscriptionId: string) =>
  worker
    .selectFrom('subscription_charges')
    .selectAll()
    .where('subscription_id', '=', subscriptionId)
    .orderBy('created_at')
    .execute();
const events = (aggregateId: string) =>
  worker
    .selectFrom('outbox_events')
    .select(['event_type', 'payload'])
    .where('aggregate_id', '=', aggregateId)
    .orderBy('created_at')
    .execute();

describe('charging (context §15)', () => {
  it('charges a due subscription and records the outcome', async () => {
    const now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000));
    const chain = fakeChain();
    chain.nextChargeAt = BigInt(Math.floor(now.getTime() / 1000) + 30 * 86_400);
    const { job, metrics } = chargeJob(chain, () => now);
    await job.run(never);
    const [charge] = await charges(sub.id);
    expect(charge).toMatchObject({
      status: 'succeeded',
      period_index: 1,
      attempt: 1,
      amount_stroops: 99_900_000n,
    });
    expect(charge?.tx_hash).toHaveLength(32);
    expect(await findSubscriptionById(worker, sub.id)).toMatchObject({
      status: 'active',
      failed_attempts: 0,
      next_charge_at: new Date(Number(chain.nextChargeAt) * 1000),
    });
    expect(chain.sent).toBe(1);
    expect(metrics.get('charges_succeeded_total')).toBe(1);
  });

  it('a failed simulation records a failed charge, goes past_due, and submits nothing', async () => {
    const now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000));
    const chain = fakeChain();
    chain.simulateError =
      'HostError: Error(WasmVm, InvalidAction) balance is not sufficient to spend';
    const { job } = chargeJob(chain, () => now);
    await job.run(never);
    expect(chain.sent).toBe(0);
    expect((await charges(sub.id))[0]).toMatchObject({ status: 'failed', attempt: 1 });
    expect(String((await charges(sub.id))[0]?.failure_code)).toContain('simulation_failed');
    const after = await findSubscriptionById(worker, sub.id);
    expect(after).toMatchObject({ status: 'past_due', failed_attempts: 1 });
    expect(Math.abs((after?.next_charge_at?.getTime() ?? 0) - (now.getTime() + DAY))).toBeLessThan(
      5000,
    );
    expect((await events(sub.id)).map((e) => e.event_type)).toEqual(['subscription.past_due']);
  });

  it('retries +1d, +3d, +5d, then cancels (time travel)', async () => {
    let now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000));
    const chain = fakeChain();
    chain.simulateError = 'HostError: insufficient allowance';
    const { job } = chargeJob(chain, () => now);
    for (const [i, days] of [1, 3, 5].entries()) {
      await job.run(never);
      const s = await findSubscriptionById(worker, sub.id);
      expect(s).toMatchObject({ status: 'past_due', failed_attempts: i + 1 });
      expect(
        Math.abs((s?.next_charge_at?.getTime() ?? 0) - (now.getTime() + days * DAY)),
      ).toBeLessThan(5000);
      now = new Date((s?.next_charge_at?.getTime() ?? 0) + 1000);
    }
    await job.run(never);
    expect(await findSubscriptionById(worker, sub.id)).toMatchObject({
      status: 'canceled',
      failed_attempts: 4,
      next_charge_at: null,
    });
    // created_at order across separate transactions is not guaranteed; check the multiset.
    expect((await events(sub.id)).map((e) => e.event_type).sort()).toEqual([
      'subscription.canceled',
      'subscription.past_due',
      'subscription.past_due',
      'subscription.past_due',
    ]);
    expect((await charges(sub.id)).map((c) => c.attempt)).toEqual([1, 2, 3, 4]);
    expect(chain.sent).toBe(0);
  });

  it('a recovered past_due subscription becomes active again', async () => {
    const now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000), {
      status: 'past_due',
      failed_attempts: 2,
    });
    const chain = fakeChain();
    chain.nextChargeAt = BigInt(Math.floor(now.getTime() / 1000) + 30 * 86_400);
    await chargeJob(chain, () => now).job.run(never);
    expect(await findSubscriptionById(worker, sub.id)).toMatchObject({
      status: 'active',
      failed_attempts: 0,
    });
    expect((await charges(sub.id))[0]).toMatchObject({ status: 'succeeded', attempt: 3 });
  });

  it('a signer refusal is a failed charge, never a submission', async () => {
    const now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000));
    const chain = fakeChain();
    const refusing: SignerClient = { sign: () => Promise.resolve(err('wrong_function')) };
    await chargeJob(chain, () => now, refusing).job.run(never);
    expect(chain.sent).toBe(0);
    expect(String((await charges(sub.id))[0]?.failure_code)).toContain('signer: wrong_function');
    expect((await findSubscriptionById(worker, sub.id))?.status).toBe('past_due');
  });

  it('two workers never charge the same subscription twice', async () => {
    const now = new Date();
    const subs = await Promise.all(
      [1, 2, 3].map(() => activeSubscription(new Date(now.getTime() - 1000))),
    );
    const chain = fakeChain();
    chain.nextChargeAt = BigInt(Math.floor(now.getTime() / 1000) + 86_400);
    await Promise.all([
      chargeJob(chain, () => now).job.run(never),
      chargeJob(chain, () => now).job.run(never),
    ]);
    for (const s of subs) expect(await charges(s.id)).toHaveLength(1);
  });

  it('a leftover charge row from a crash neither poisons the batch nor blocks the subscription', async () => {
    const now = new Date();
    const stuck = await activeSubscription(new Date(now.getTime() - 1000));
    const healthy = await activeSubscription(new Date(now.getTime() - 1000));
    // Simulated crash: a charge was recorded and submitted, then the worker died.
    await worker
      .insertInto('subscription_charges')
      .values({
        id: newId(),
        subscription_id: stuck.id,
        period_index: 1,
        amount_stroops: 99_900_000n,
        attempt: 1,
        status: 'submitted',
      })
      .execute();
    const chain = fakeChain();
    chain.nextChargeAt = BigInt(Math.floor(now.getTime() / 1000) + 86_400);
    await chargeJob(chain, () => now).job.run(never);
    expect(await charges(stuck.id)).toEqual([
      expect.objectContaining({ status: 'succeeded', period_index: 1, attempt: 1 }),
    ]);
    expect((await charges(healthy.id))[0]).toMatchObject({ status: 'succeeded' });
  });

  it('a charge that is not due on-chain is not a payment failure and resyncs the schedule', async () => {
    const now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000));
    const chain = fakeChain();
    chain.simulateError = 'HostError: Error(Contract, #10)';
    chain.onChainNext = BigInt(Math.floor(now.getTime() / 1000) + 3600);
    await chargeJob(chain, () => now).job.run(never);
    expect((await charges(sub.id))[0]).toMatchObject({ status: 'failed', failure_code: 'not_due' });
    expect(await findSubscriptionById(worker, sub.id)).toMatchObject({
      status: 'active',
      next_charge_at: new Date(Number(chain.onChainNext) * 1000),
    });
  });

  it('a token error #10 (insufficient balance) while due is a real failure, not "not due"', async () => {
    const now = new Date();
    const sub = await activeSubscription(new Date(now.getTime() - 1000));
    const chain = fakeChain();
    // The USDC SAC reports insufficient balance as Error(Contract, #10) — same code as NotDue.
    chain.simulateError = 'HostError: Error(Contract, #10) balance is not sufficient to spend';
    await chargeJob(chain, () => now).job.run(never);
    expect(await findSubscriptionById(worker, sub.id)).toMatchObject({
      status: 'past_due',
      failed_attempts: 1,
    });
  });
});

describe('contract event sync (context §13.4)', () => {
  function eventsClient(list: rpc.Api.EventResponse[]): ContractEventsClient {
    return {
      getLatestLedger: () => Promise.resolve({ sequence: 1 }),
      getEvents: (req) => {
        return Promise.resolve({
          events: 'cursor' in req ? [] : list,
          cursor: 'c-end',
          latestLedger: 200,
          oldestLedger: 1,
          latestLedgerCloseTime: '',
          oldestLedgerCloseTime: '',
        });
      },
    };
  }
  const event = (name: string, subId: bigint, value: xdr.ScVal): rpc.Api.EventResponse => ({
    id: `evt-${newId()}`,
    type: 'contract',
    ledger: 150,
    ledgerClosedAt: '2026-10-16T12:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: randomBytes(32).toString('hex'),
    contractId: new Contract(contractId),
    topic: [nativeToScVal(name, { type: 'symbol' }), nativeToScVal(subId, { type: 'u64' })],
    value,
  });

  it('applies charged and wallet-side canceled events', async () => {
    const sub = await activeSubscription(new Date(Date.now() + DAY));
    const subId = sub.contract_subscription_id ?? 0n;
    const next = BigInt(Math.floor(Date.now() / 1000) + 60 * 86_400);
    const charged = nativeToScVal(
      { amount: 99_900_000n, next_charge_at: next },
      { type: { amount: ['symbol', 'i128'], next_charge_at: ['symbol', 'u64'] } },
    );
    const canceled = nativeToScVal(
      { by: new Address(sub.subscriber_address ?? '') },
      { type: { by: ['symbol', 'address'] } },
    );
    const job = createContractEventsJob({
      db: worker,
      client: eventsClient([event('charged', subId, charged), event('canceled', subId, canceled)]),
      contractId,
      startLedger: 1,
      metrics: createMetrics(),
      logger: silent,
    });
    await job.run(never);
    const after = await findSubscriptionById(worker, sub.id);
    expect(after).toMatchObject({ status: 'canceled' });
    const types = (await events(sub.id)).map((e) => e.event_type);
    expect(types).toEqual(['subscription.renewed', 'subscription.canceled']);
    const cancel = (await events(sub.id)).find((e) => e.event_type === 'subscription.canceled');
    expect(cancel?.payload).toMatchObject({ canceled_by: 'subscriber' });
    await job.run(never);
    expect((await events(sub.id)).length).toBe(2);
  });
});

describe('allowance warnings', () => {
  it('emits subscription.allowance_expiring once per allowance', async () => {
    const sub = await activeSubscription(new Date(Date.now() + DAY), {
      allowance_expires_ledger: 1_000 + 10 * 17_280,
    });
    const job = createAllowanceWarningJob({
      db: worker,
      latestLedger: () => Promise.resolve(1_000),
      now: () => new Date(),
      randomBytes: cryptoRandomBytes,
    });
    await job.run(never);
    await job.run(never);
    const warnings = (await events(sub.id)).filter(
      (e) => e.event_type === 'subscription.allowance_expiring',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload).toMatchObject({ ledgers_left: 10 * 17_280 });
  });
});
