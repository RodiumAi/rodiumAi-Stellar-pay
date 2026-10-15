import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  isChargeDue,
  newSubscriptionState,
  transitionSubscription,
  type SubscriptionEvent,
  type SubscriptionState,
  type SubscriptionStatus,
} from './subscription.js';
import { DAY, duration, instant, type Duration, type Instant } from './time.js';

const INTERVAL = (30 * DAY) as Duration;
const T0 = instant(1_700_000_000_000);
const at = (offset: number): Instant => instant(T0 + offset);

function expectOk(state: SubscriptionState, event: SubscriptionEvent): SubscriptionState {
  const result = transitionSubscription(state, event);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const active = (): SubscriptionState =>
  expectOk(newSubscriptionState(INTERVAL), { type: 'activated', at: T0 });

describe('subscription state machine', () => {
  it('activates with the first period already paid', () => {
    expect(active()).toEqual({
      status: 'active',
      interval: INTERVAL,
      currentPeriodEnd: at(INTERVAL),
      nextChargeAt: at(INTERVAL),
      failedAttempts: 0,
      canceledAt: null,
    });
  });

  it('advances exactly one interval on an on-time charge', () => {
    const next = expectOk(active(), { type: 'charge_succeeded', at: at(INTERVAL + 5 * 60_000) });
    expect(next.status).toBe('active');
    expect(next.nextChargeAt).toBe(at(2 * INTERVAL));
  });

  it('does not back-charge when more than one interval late', () => {
    const lateAt = at(2 * INTERVAL + DAY);
    const next = expectOk(active(), { type: 'charge_succeeded', at: lateAt });
    expect(next.nextChargeAt).toBe(instant(lateAt + INTERVAL));
  });

  it('refuses a second charge in the same period', () => {
    const charged = expectOk(active(), { type: 'charge_succeeded', at: at(INTERVAL) });
    expect(
      transitionSubscription(charged, { type: 'charge_succeeded', at: at(INTERVAL + 1) }),
    ).toEqual({
      ok: false,
      error: { code: 'charge_not_due' },
    });
    expect(
      transitionSubscription(charged, { type: 'charge_failed', at: at(INTERVAL + 1) }),
    ).toEqual({
      ok: false,
      error: { code: 'charge_not_due' },
    });
  });

  it('retries +1d, +3d, +5d after failures, then cancels', () => {
    let state = active();
    let now = at(INTERVAL);
    for (const [i, delay] of DEFAULT_RETRY_POLICY.retryDelays.entries()) {
      state = expectOk(state, { type: 'charge_failed', at: now });
      expect(state.status).toBe('past_due');
      expect(state.failedAttempts).toBe(i + 1);
      expect(state.nextChargeAt).toBe(instant(now + delay));
      now = instant(now + delay);
    }
    state = expectOk(state, { type: 'charge_failed', at: now });
    expect(state).toMatchObject({
      status: 'canceled',
      nextChargeAt: null,
      canceledAt: now,
      failedAttempts: 4,
    });
  });

  it('recovers from past_due with a fresh period at the successful charge', () => {
    const failed = expectOk(active(), { type: 'charge_failed', at: at(INTERVAL) });
    const retryAt = at(INTERVAL + DAY);
    const recovered = expectOk(failed, { type: 'charge_succeeded', at: retryAt });
    expect(recovered).toMatchObject({
      status: 'active',
      failedAttempts: 0,
      currentPeriodEnd: instant(retryAt + INTERVAL),
      nextChargeAt: instant(retryAt + INTERVAL),
    });
  });

  it('honours a custom retry policy', () => {
    const failed = transitionSubscription(
      active(),
      { type: 'charge_failed', at: at(INTERVAL) },
      { retryDelays: [] },
    );
    expect(failed.ok && failed.value.status).toBe('canceled');
  });

  it.each<SubscriptionStatus>(['active', 'past_due'])('cancels from %s', (status) => {
    const state =
      status === 'active'
        ? active()
        : expectOk(active(), { type: 'charge_failed', at: at(INTERVAL) });
    const now = at(INTERVAL + 1);
    expect(expectOk(state, { type: 'cancel', at: now })).toMatchObject({
      status: 'canceled',
      nextChargeAt: null,
      canceledAt: now,
    });
  });

  const canceled = (): SubscriptionState => expectOk(active(), { type: 'cancel', at: at(1) });

  it.each<[string, () => SubscriptionState, SubscriptionEvent]>([
    [
      'incomplete + charge_succeeded',
      () => newSubscriptionState(INTERVAL),
      { type: 'charge_succeeded', at: T0 },
    ],
    [
      'incomplete + charge_failed',
      () => newSubscriptionState(INTERVAL),
      { type: 'charge_failed', at: T0 },
    ],
    ['incomplete + cancel', () => newSubscriptionState(INTERVAL), { type: 'cancel', at: T0 }],
    ['active + activated', active, { type: 'activated', at: T0 }],
    ['canceled + activated', canceled, { type: 'activated', at: T0 }],
    ['canceled + charge_succeeded', canceled, { type: 'charge_succeeded', at: at(INTERVAL) }],
    ['canceled + charge_failed', canceled, { type: 'charge_failed', at: at(INTERVAL) }],
    ['canceled + cancel', canceled, { type: 'cancel', at: at(2) }],
  ])('%s → invalid_transition', (_name, make, event) => {
    const state = make();
    expect(transitionSubscription(state, event)).toEqual({
      ok: false,
      error: { code: 'invalid_transition', from: state.status, event: event.type },
    });
  });

  it('reports charge due only for active/past_due at or after next_charge_at', () => {
    const state = active();
    expect(isChargeDue(state, at(INTERVAL - 1))).toBe(false);
    expect(isChargeDue(state, at(INTERVAL))).toBe(true);
    expect(isChargeDue(newSubscriptionState(duration(DAY)), at(INTERVAL))).toBe(false);
    expect(isChargeDue(canceled(), at(10 * INTERVAL))).toBe(false);
  });
});
