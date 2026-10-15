import { stroops, type Stroops } from './money/stroops.js';
import { assertNever, err, ok, type Result } from './result.js';
import type { Instant } from './time.js';

export type PaymentStatus =
  'pending' | 'underpaid' | 'confirmed' | 'expired' | 'late_paid' | 'refunded';

export interface PaymentState {
  readonly status: PaymentStatus;
  readonly amountDue: Stroops;
  readonly amountReceived: Stroops;
  readonly expiresAt: Instant;
}

export type PaymentEvent =
  | { readonly type: 'receipt'; readonly amount: Stroops; readonly ledgerClosedAt: Instant }
  | { readonly type: 'expire'; readonly now: Instant }
  | { readonly type: 'refund' };

export interface PaymentTransition {
  readonly state: PaymentState;
  /** Amount from this event above what is due; recorded for refund review, never dropped. */
  readonly excess: Stroops;
}

export type PaymentTransitionError =
  | {
      readonly code: 'invalid_transition';
      readonly from: PaymentStatus;
      readonly event: PaymentEvent['type'];
    }
  | { readonly code: 'not_yet_expired' }
  | { readonly code: 'non_positive_amount' }
  | { readonly code: 'amount_out_of_range' };

type TransitionResult = Result<PaymentTransition, PaymentTransitionError>;

const ZERO = 0n as Stroops;

export function transitionPayment(state: PaymentState, event: PaymentEvent): TransitionResult {
  switch (event.type) {
    case 'receipt':
      return applyReceipt(state, event.amount, event.ledgerClosedAt);
    case 'expire':
      return expire(state, event.now);
    case 'refund':
      return state.status === 'confirmed'
        ? ok({ state: { ...state, status: 'refunded' }, excess: ZERO })
        : invalid(state, event);
    default:
      return assertNever(event);
  }
}

function applyReceipt(state: PaymentState, amount: Stroops, at: Instant): TransitionResult {
  if (amount <= 0n) {
    return err({ code: 'non_positive_amount' });
  }
  const received = stroops(state.amountReceived + amount);
  if (!received.ok) {
    return err({ code: 'amount_out_of_range' });
  }
  const next = { ...state, amountReceived: received.value };

  switch (state.status) {
    case 'pending':
    case 'underpaid':
      if (at >= state.expiresAt) {
        // The quote was only valid until expires_at; late money goes to manual review.
        return ok({ state: { ...next, status: 'late_paid' }, excess: ZERO });
      }
      if (received.value >= state.amountDue) {
        return ok({
          state: { ...next, status: 'confirmed' },
          excess: (received.value - state.amountDue) as Stroops,
        });
      }
      return ok({ state: { ...next, status: 'underpaid' }, excess: ZERO });
    case 'confirmed':
      return ok({ state: next, excess: amount });
    case 'expired':
    case 'late_paid':
      return ok({ state: { ...next, status: 'late_paid' }, excess: ZERO });
    case 'refunded':
      return invalid(state, { type: 'receipt', amount, ledgerClosedAt: at });
    default:
      return assertNever(state.status);
  }
}

function expire(state: PaymentState, now: Instant): TransitionResult {
  if (state.status !== 'pending' && state.status !== 'underpaid') {
    return invalid(state, { type: 'expire', now });
  }
  if (now < state.expiresAt) {
    return err({ code: 'not_yet_expired' });
  }
  return ok({ state: { ...state, status: 'expired' }, excess: ZERO });
}

function invalid(state: PaymentState, event: PaymentEvent): TransitionResult {
  return err({ code: 'invalid_transition', from: state.status, event: event.type });
}
