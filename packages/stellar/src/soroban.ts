import { err, ok, type Result } from '@rp/core/result';
import {
  Address,
  Contract,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Account,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';

/** The subset of `rpc.Server` used for contract calls, so tests can stub it. */
export interface SorobanClient {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface ChargeParams {
  readonly contractId: string;
  readonly keeper: string;
  readonly subId: bigint;
  readonly networkPassphrase: string;
  /** Inclusion fee; the resource fee from simulation is added on top. */
  readonly baseFee: string;
  readonly maxFeeStroops: bigint;
  readonly timeoutSeconds: number;
}

export type SimulationFailure =
  | { readonly code: 'simulation_failed'; readonly detail: string }
  | { readonly code: 'fee_too_high'; readonly detail: string };

/**
 * Builds `charge(sub_id)` with the keeper as source and simulates it first (context §15):
 * a simulation failure (no balance, no allowance, not due) means nothing is submitted.
 * Returns the assembled, unsigned XDR for the signer.
 */
export async function prepareCharge(
  client: SorobanClient,
  p: ChargeParams,
): Promise<Result<string, SimulationFailure>> {
  const account = await client.getAccount(p.keeper);
  const tx = new TransactionBuilder(account, {
    fee: p.baseFee,
    networkPassphrase: p.networkPassphrase,
  })
    .addOperation(
      new Contract(p.contractId).call('charge', nativeToScVal(p.subId, { type: 'u64' })),
    )
    .setTimeout(p.timeoutSeconds)
    .build();
  const sim = await client.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim))
    return err({ code: 'simulation_failed', detail: sim.error.slice(0, 300) });
  const assembled = rpc.assembleTransaction(tx, sim).build();
  if (BigInt(assembled.fee) > p.maxFeeStroops) {
    return err({
      code: 'fee_too_high',
      detail: `fee ${assembled.fee} > cap ${p.maxFeeStroops.toString()}`,
    });
  }
  return ok(assembled.toXdr());
}

/** Storage key of one subscription: `#[contracttype] enum Key { …, Sub(u64) }`. */
export function subscriptionLedgerKey(contractId: string, subId: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([
        nativeToScVal('Sub', { type: 'symbol' }),
        nativeToScVal(subId, { type: 'u64' }),
      ]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

export interface ExtendTtlParams {
  readonly contractId: string;
  readonly keeper: string;
  readonly subIds: readonly bigint[];
  readonly extendToLedgers: number;
  readonly networkPassphrase: string;
  readonly baseFee: string;
  readonly timeoutSeconds: number;
}

/**
 * TTL extension for the contract instance and the given subscriptions (§14.4); the
 * signer only accepts footprints of our own contract (keeper guard). `null` when every
 * entry already lives past `extendToLedgers` — nothing to sign or pay for.
 */
export async function prepareExtendTtl(
  client: SorobanClient,
  p: ExtendTtlParams,
): Promise<Result<string | null, SimulationFailure>> {
  const account = await client.getAccount(p.keeper);
  const keys = [
    new Contract(p.contractId).getFootprint(),
    ...p.subIds.map((id) => subscriptionLedgerKey(p.contractId, id)),
  ];
  const tx = new TransactionBuilder(account, {
    fee: p.baseFee,
    networkPassphrase: p.networkPassphrase,
  })
    .addOperation(Operation.extendFootprintTtl({ extendTo: p.extendToLedgers }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
    .setTimeout(p.timeoutSeconds)
    .build();
  const sim = await client.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim))
    return err({ code: 'simulation_failed', detail: sim.error.slice(0, 300) });
  // RPC drops entries that already live past `extendTo` (the contract bumps its own
  // entries on every call); an empty footprint means there is nothing to extend.
  const footprint = sim.transactionData.build().resources.footprint;
  if (footprint.readOnly.length === 0) return ok(null);
  return ok(rpc.assembleTransaction(tx, sim).build().toXdr());
}

export type SubmitOutcome =
  | { readonly status: 'success'; readonly hash: string; readonly returnValue: unknown }
  | { readonly status: 'failed'; readonly hash: string; readonly detail: string }
  | { readonly status: 'pending'; readonly hash: string };

/** Sends a signed transaction and waits (bounded) for its result. */
export async function submitAndWait(
  client: SorobanClient,
  signedXdr: string,
  networkPassphrase: string,
  opts: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<SubmitOutcome> {
  const tx = TransactionBuilder.fromXdr(signedXdr, networkPassphrase);
  const sent = await client.sendTransaction(tx);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    return { status: 'failed', hash: sent.hash, detail: sent.status };
  }
  for (let i = 0; i < (opts.attempts ?? 30); i++) {
    const res = await client.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        status: 'success',
        hash: sent.hash,
        returnValue: res.returnValue === undefined ? undefined : scValToNative(res.returnValue),
      };
    }
    if (res.status === rpc.Api.GetTransactionStatus.FAILED)
      return { status: 'failed', hash: sent.hash, detail: 'FAILED' };
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 1000));
  }
  return { status: 'pending', hash: sent.hash };
}

/** `ChargeOutcome { sub_id, amount, next_charge_at }` returned by `charge`. */
export function parseChargeOutcome(
  value: unknown,
): { readonly subId: bigint; readonly amount: bigint; readonly nextChargeAt: bigint } | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = new Map<string, unknown>(Object.entries(value));
  const subId = v.get('sub_id');
  const amount = v.get('amount');
  const next = v.get('next_charge_at');
  return typeof subId === 'bigint' && typeof amount === 'bigint' && typeof next === 'bigint'
    ? { subId, amount, nextChargeAt: next }
    : null;
}

export interface OnChainSubscription {
  readonly nextChargeAt: bigint;
  readonly active: boolean;
}

/**
 * Reads `get(sub_id)` by simulation (no fee, nothing submitted). Used to tell "not due
 * yet" apart from payment failures: contract error codes are only unique per contract
 * (the USDC SAC's balance error is also `#10`), so error strings cannot be trusted.
 */
export async function readSubscription(
  client: SorobanClient,
  p: {
    readonly contractId: string;
    readonly source: string;
    readonly subId: bigint;
    readonly networkPassphrase: string;
  },
): Promise<OnChainSubscription | null> {
  const value = await simulateView(
    client,
    p,
    new Contract(p.contractId).call('get', nativeToScVal(p.subId, { type: 'u64' })),
  );
  if (typeof value !== 'object' || value === null) return null;
  const v = new Map<string, unknown>(Object.entries(value));
  const next = v.get('next_charge_at');
  const status: unknown = v.get('status');
  if (typeof next !== 'bigint') return null;
  // `SubStatus` is a unit enum: scValToNative yields ['Active'] / ['Canceled'].
  const active = Array.isArray(status) && status[0] === 'Active';
  return { nextChargeAt: next, active };
}

/** `is_paused()` via simulation; null when the chain cannot answer. */
export async function readPaused(
  client: SorobanClient,
  p: { readonly contractId: string; readonly source: string; readonly networkPassphrase: string },
): Promise<boolean | null> {
  const value = await simulateView(client, p, new Contract(p.contractId).call('is_paused'));
  return typeof value === 'boolean' ? value : null;
}

/** Simulates a read-only contract call and returns its native return value. */
async function simulateView(
  client: SorobanClient,
  p: { readonly source: string; readonly networkPassphrase: string },
  op: xdr.Operation,
): Promise<unknown> {
  const account = await client.getAccount(p.source);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: p.networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await client.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) return undefined;
  return scValToNative(sim.result.retval);
}
