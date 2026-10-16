import { formatAmount, type Stroops } from '@rp/core/money/stroops';
import { err, ok, type Result } from '@rp/core/result';
import {
  Address,
  FeeBumpTransaction,
  Keypair,
  scValToNative,
  StrKey,
  TransactionBuilder,
  type OperationRecord,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

/** Context §13.3: time bounds no more than 5 minutes ahead. */
export const MAX_TIME_BOUND_SECONDS = 300;

export type GuardError =
  | 'malformed_xdr'
  | 'fee_bump_not_allowed'
  | 'wrong_network_or_unsigned'
  | 'wrong_operation_count'
  | 'wrong_operation_type'
  | 'wrong_destination'
  | 'wrong_asset'
  | 'wrong_amount'
  | 'wrong_memo'
  | 'missing_time_bounds'
  | 'time_bounds_too_long'
  | 'expired'
  | 'fee_too_high'
  | 'wrong_contract'
  | 'wrong_function'
  | 'wrong_arguments'
  | 'wrong_source'
  | 'foreign_footprint';

export interface GuardPass {
  /** Hex hash on the configured network; callers reject one that was already submitted. */
  readonly hash: string;
  readonly transaction: Transaction;
}

interface CommonRules {
  readonly networkPassphrase: string;
  readonly maxFeeStroops: bigint;
  readonly nowSeconds: number;
}

type GuardResult = Result<GuardPass, GuardError>;

function decode(envelopeXdr: string, passphrase: string): Result<Transaction, GuardError> {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXdr(envelopeXdr, passphrase);
  } catch {
    return err('malformed_xdr');
  }
  if (parsed instanceof FeeBumpTransaction) {
    return err('fee_bump_not_allowed');
  }
  return ok(parsed);
}

function checkTimeAndFee(tx: Transaction, rules: CommonRules): GuardError | null {
  const bounds = tx.timeBounds;
  const max = bounds === undefined ? 0 : Number(bounds.maxTime);
  if (max === 0) {
    return 'missing_time_bounds';
  }
  if (max > rules.nowSeconds + MAX_TIME_BOUND_SECONDS) {
    return 'time_bounds_too_long';
  }
  if (max <= rules.nowSeconds) {
    return 'expired';
  }
  if (BigInt(tx.fee) > rules.maxFeeStroops) {
    return 'fee_too_high';
  }
  return null;
}

/**
 * The envelope must carry a valid signature by its source account over the hash for
 * *our* passphrase. A transaction signed for another network fails here, because the
 * network passphrase is part of the signed payload.
 */
function signedForNetwork(tx: Transaction): boolean {
  const source = StrKey.isValidMed25519PublicKey(tx.source)
    ? StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(tx.source).subarray(0, 32))
    : tx.source;
  const keypair = Keypair.fromPublicKey(source);
  const hash = tx.hash();
  const hint = Buffer.from(keypair.signatureHint());
  return tx.signatures.some(
    (s) => hint.equals(s.hint.value) && keypair.verify(hash, s.signature.value),
  );
}

function single(tx: Transaction): Result<OperationRecord, GuardError> {
  const [op, ...rest] = tx.operations;
  return op === undefined || rest.length > 0 ? err('wrong_operation_count') : ok(op);
}

export interface PaymentRules extends CommonRules {
  readonly merchant: string;
  readonly usdc: { readonly code: string; readonly issuer: string };
  /** The remaining amount due on the payment. */
  readonly amount: Stroops;
  readonly memo: string;
}

/** Guard for `POST /c/{token}/submit` on a one-time payment (context §13.3). */
export function guardPaymentTransaction(envelopeXdr: string, rules: PaymentRules): GuardResult {
  const decoded = decode(envelopeXdr, rules.networkPassphrase);
  if (!decoded.ok) return decoded;
  const tx = decoded.value;
  if (!signedForNetwork(tx)) return err('wrong_network_or_unsigned');
  const op = single(tx);
  if (!op.ok) return op;
  if (op.value.type !== 'payment') return err('wrong_operation_type');
  const payment = op.value;
  if (payment.destination !== rules.merchant) return err('wrong_destination');
  if (
    payment.asset.isNative() ||
    payment.asset.getCode() !== rules.usdc.code ||
    payment.asset.getIssuer() !== rules.usdc.issuer
  ) {
    return err('wrong_asset');
  }
  if (payment.amount !== formatAmount(rules.amount)) return err('wrong_amount');
  if (tx.memo.type !== 'text' || memoText(tx.memo.value) !== rules.memo) return err('wrong_memo');
  const timeOrFee = checkTimeAndFee(tx, rules);
  if (timeOrFee !== null) return err(timeOrFee);
  return ok({ hash: Buffer.from(tx.hash()).toString('hex'), transaction: tx });
}

function memoText(value: unknown): string {
  return value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value);
}

interface ContractCall {
  readonly contractId: string;
  readonly functionName: string;
  readonly args: readonly xdr.ScVal[];
}

function contractCall(op: OperationRecord): Result<ContractCall, GuardError> {
  if (op.type !== 'invokeHostFunction') return err('wrong_operation_type');
  const fn = op.func;
  if (fn.type !== 'hostFunctionTypeInvokeContract') return err('wrong_operation_type');
  const invoke = fn.invokeContract;
  return ok({
    contractId: Address.fromScAddress(invoke.contractAddress).toString(),
    functionName: invoke.functionName.toString(),
    args: invoke.args,
  });
}

function native(v: xdr.ScVal | undefined): unknown {
  if (v === undefined) return undefined;
  try {
    return scValToNative(v);
  } catch {
    return undefined;
  }
}

export interface SubscribeRules extends CommonRules {
  readonly contractId: string;
  readonly planId: number;
  readonly periods: number;
  /** The wallet address the user connected in checkout. */
  readonly subscriber: string;
}

/** Guard for the checkout subscribe flow: exactly one `subscribe` on our contract. */
export function guardSubscribeTransaction(envelopeXdr: string, rules: SubscribeRules): GuardResult {
  const decoded = decode(envelopeXdr, rules.networkPassphrase);
  if (!decoded.ok) return decoded;
  const tx = decoded.value;
  if (!signedForNetwork(tx)) return err('wrong_network_or_unsigned');
  if (tx.source !== rules.subscriber) return err('wrong_source');
  const op = single(tx);
  if (!op.ok) return op;
  const call = contractCall(op.value);
  if (!call.ok) return call;
  if (call.value.contractId !== rules.contractId) return err('wrong_contract');
  if (call.value.functionName !== 'subscribe') return err('wrong_function');
  const [subscriber, planId, periods, liveUntil, ...extra] = call.value.args.map(native);
  if (
    extra.length > 0 ||
    subscriber !== rules.subscriber ||
    planId !== rules.planId ||
    periods !== rules.periods ||
    typeof liveUntil !== 'number'
  ) {
    return err('wrong_arguments');
  }
  const timeOrFee = checkTimeAndFee(tx, rules);
  if (timeOrFee !== null) return err(timeOrFee);
  return ok({ hash: Buffer.from(tx.hash()).toString('hex'), transaction: tx });
}

export interface KeeperRules extends CommonRules {
  readonly contractId: string;
  readonly keeper: string;
}

/**
 * Guard the signer applies before signing (context §14.5): exactly one `charge(sub_id)`
 * on our contract, or one TTL extension, with the keeper as source. Runs on the
 * unsigned transaction, so there is no signature check here.
 */
export function guardKeeperTransaction(envelopeXdr: string, rules: KeeperRules): GuardResult {
  const decoded = decode(envelopeXdr, rules.networkPassphrase);
  if (!decoded.ok) return decoded;
  const tx = decoded.value;
  if (tx.source !== rules.keeper) return err('wrong_source');
  const op = single(tx);
  if (!op.ok) return op;
  if (op.value.source !== undefined && op.value.source !== rules.keeper) return err('wrong_source');
  if (op.value.type === 'extendFootprintTtl') {
    if (!footprintOnlyTouches(tx, rules.contractId)) return err('foreign_footprint');
  } else {
    const call = contractCall(op.value);
    if (!call.ok) return call;
    if (call.value.contractId !== rules.contractId) return err('wrong_contract');
    if (call.value.functionName !== 'charge') return err('wrong_function');
    const [subId, ...extra] = call.value.args.map(native);
    if (extra.length > 0 || typeof subId !== 'bigint') return err('wrong_arguments');
  }
  const timeOrFee = checkTimeAndFee(tx, rules);
  if (timeOrFee !== null) return err(timeOrFee);
  return ok({ hash: Buffer.from(tx.hash()).toString('hex'), transaction: tx });
}

/**
 * A TTL extension may only cover our contract's own instance, data and code; otherwise
 * the keeper could be made to pay for extending arbitrary ledger entries.
 */
function footprintOnlyTouches(tx: Transaction, contractId: string): boolean {
  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') return false;
  const ext = envelope.v1.tx.ext;
  if (ext.type !== 'sorobanData') return false;
  const { readOnly, readWrite } = ext.sorobanData.resources.footprint;
  if (readWrite.length > 0 || readOnly.length === 0) return false;
  return readOnly.every(
    (key) =>
      key.type === 'contractCode' ||
      (key.type === 'contractData' &&
        Address.fromScAddress(key.contractData.contract).toString() === contractId),
  );
}
