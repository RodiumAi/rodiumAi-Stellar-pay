import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_STROOPS, type Stroops } from './money/stroops.js';
import {
  transitionPayment,
  type PaymentEvent,
  type PaymentState,
  type PaymentStatus,
} from './payment.js';
import { instant } from './time.js';

const s = (n: bigint): Stroops => n as Stroops;
const EXPIRES_AT = instant(1_000_000);
const BEFORE = instant(999_999);
const AFTER = instant(1_000_000);

function payment(status: PaymentStatus, received = 0n): PaymentState {
  return { status, amountDue: s(100n), amountReceived: s(received), expiresAt: EXPIRES_AT };
}

const receipt = (amount: bigint, at = BEFORE): PaymentEvent => ({
  type: 'receipt',
  amount: s(amount),
  ledgerClosedAt: at,
});

describe('payment state machine — allowed transitions', () => {
  it.each<[string, PaymentState, PaymentEvent, PaymentStatus, bigint, bigint]>([
    ['pending → confirmed (exact)', payment('pending'), receipt(100n), 'confirmed', 100n, 0n],
    ['pending → confirmed (over)', payment('pending'), receipt(130n), 'confirmed', 130n, 30n],
    ['pending → underpaid', payment('pending'), receipt(40n), 'underpaid', 40n, 0n],
    ['underpaid → underpaid', payment('underpaid', 40n), receipt(10n), 'underpaid', 50n, 0n],
    ['underpaid → confirmed', payment('underpaid', 40n), receipt(60n), 'confirmed', 100n, 0n],
    [
      'underpaid → confirmed (over)',
      payment('underpaid', 40n),
      receipt(70n),
      'confirmed',
      110n,
      10n,
    ],
    [
      'confirmed + receipt keeps excess',
      payment('confirmed', 100n),
      receipt(5n),
      'confirmed',
      105n,
      5n,
    ],
    [
      'pending + late receipt → late_paid',
      payment('pending'),
      receipt(100n, AFTER),
      'late_paid',
      100n,
      0n,
    ],
    [
      'underpaid + late receipt → late_paid',
      payment('underpaid', 40n),
      receipt(60n, AFTER),
      'late_paid',
      100n,
      0n,
    ],
    ['expired → late_paid', payment('expired'), receipt(100n, AFTER), 'late_paid', 100n, 0n],
    [
      'late_paid accumulates',
      payment('late_paid', 100n),
      receipt(1n, AFTER),
      'late_paid',
      101n,
      0n,
    ],
    ['pending → expired', payment('pending'), { type: 'expire', now: AFTER }, 'expired', 0n, 0n],
    [
      'underpaid → expired',
      payment('underpaid', 40n),
      { type: 'expire', now: AFTER },
      'expired',
      40n,
      0n,
    ],
    ['confirmed → refunded', payment('confirmed', 100n), { type: 'refund' }, 'refunded', 100n, 0n],
  ])('%s', (_name, state, event, status, received, excess) => {
    expect(transitionPayment(state, event)).toEqual({
      ok: true,
      value: { state: { ...state, status, amountReceived: received }, excess },
    });
  });
});

describe('payment state machine — rejected transitions', () => {
  it.each<[PaymentStatus, PaymentEvent]>([
    ['refunded', receipt(1n)],
    ['confirmed', { type: 'expire', now: AFTER }],
    ['expired', { type: 'expire', now: AFTER }],
    ['late_paid', { type: 'expire', now: AFTER }],
    ['refunded', { type: 'expire', now: AFTER }],
    ['pending', { type: 'refund' }],
    ['underpaid', { type: 'refund' }],
    ['expired', { type: 'refund' }],
    ['late_paid', { type: 'refund' }],
    ['refunded', { type: 'refund' }],
  ])('%s + %o → invalid_transition', (status, event) => {
    expect(transitionPayment(payment(status), event)).toEqual({
      ok: false,
      error: { code: 'invalid_transition', from: status, event: event.type },
    });
  });

  it('refuses to expire before expires_at', () => {
    expect(transitionPayment(payment('pending'), { type: 'expire', now: BEFORE })).toEqual({
      ok: false,
      error: { code: 'not_yet_expired' },
    });
  });

  it('refuses non-positive receipts', () => {
    expect(transitionPayment(payment('pending'), receipt(0n))).toEqual({
      ok: false,
      error: { code: 'non_positive_amount' },
    });
  });

  it('refuses receipts that overflow bigint', () => {
    expect(transitionPayment(payment('confirmed', MAX_STROOPS), receipt(1n))).toEqual({
      ok: false,
      error: { code: 'amount_out_of_range' },
    });
  });
});

describe('payment accumulation', () => {
  it('confirms exactly when the running sum reaches the amount due, keeping every stroop', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 60n }), { minLength: 1, maxLength: 10 }),
        (amounts) => {
          let state = payment('pending');
          let totalExcess = 0n;
          for (const amount of amounts) {
            const result = transitionPayment(state, receipt(amount));
            if (!result.ok) throw new Error(result.error.code);
            state = result.value.state;
            totalExcess += result.value.excess;
          }
          const sum = amounts.reduce((a, b) => a + b, 0n);
          expect(state.amountReceived).toBe(sum);
          expect(state.status).toBe(sum >= 100n ? 'confirmed' : 'underpaid');
          expect(totalExcess).toBe(sum >= 100n ? sum - 100n : 0n);
        },
      ),
    );
  });
});
