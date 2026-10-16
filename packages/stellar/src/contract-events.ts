import { scValToNative, type rpc } from '@stellar/stellar-sdk';

/** Events emitted by contracts/subscription (`#[contractevent]`, snake_case names). */
export type SubscriptionEvent =
  | {
      readonly type: 'sub_created';
      readonly subId: bigint;
      readonly subscriber: string;
      readonly planId: number;
      readonly price: bigint;
      readonly nextChargeAt: bigint;
    }
  | {
      readonly type: 'charged';
      readonly subId: bigint;
      readonly amount: bigint;
      readonly nextChargeAt: bigint;
    }
  | { readonly type: 'canceled'; readonly subId: bigint; readonly by: string };

export interface ParsedEvent {
  readonly event: SubscriptionEvent;
  readonly cursor: string;
  readonly txHash: string;
  readonly ledger: number;
  readonly ledgerClosedAt: Date;
}

function field(data: unknown, name: string): unknown {
  return typeof data === 'object' && data !== null
    ? new Map(Object.entries(data)).get(name)
    : undefined;
}

const isBig = (v: unknown): v is bigint => typeof v === 'bigint';
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Parses one contract event; returns null for events from other contracts or with
 * unexpected shapes (they are logged by the caller, never guessed at).
 */
export function parseSubscriptionEvent(
  e: rpc.Api.EventResponse,
  contractId: string,
): ParsedEvent | null {
  if (e.contractId?.contractId() !== contractId || !e.inSuccessfulContractCall) {
    return null;
  }
  const [nameVal, idVal] = e.topic;
  if (nameVal === undefined || idVal === undefined) return null;
  const name: unknown = scValToNative(nameVal);
  const subId: unknown = scValToNative(idVal);
  const data: unknown = scValToNative(e.value);
  if (!isBig(subId)) return null;

  let event: SubscriptionEvent | null = null;
  if (name === 'sub_created') {
    const [subscriber, planId, price, next] = [
      'subscriber',
      'plan_id',
      'price',
      'next_charge_at',
    ].map((k) => field(data, k));
    if (isStr(subscriber) && typeof planId === 'number' && isBig(price) && isBig(next)) {
      event = { type: 'sub_created', subId, subscriber, planId, price, nextChargeAt: next };
    }
  } else if (name === 'charged') {
    const [amount, next] = ['amount', 'next_charge_at'].map((k) => field(data, k));
    if (isBig(amount) && isBig(next))
      event = { type: 'charged', subId, amount, nextChargeAt: next };
  } else if (name === 'canceled') {
    const by = field(data, 'by');
    if (isStr(by)) event = { type: 'canceled', subId, by };
  }
  return event === null
    ? null
    : {
        event,
        cursor: e.id,
        txHash: e.txHash,
        ledger: e.ledger,
        ledgerClosedAt: new Date(e.ledgerClosedAt),
      };
}
