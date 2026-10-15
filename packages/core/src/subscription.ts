import { assertNever, err, ok, type Result } from './result.js';
import { addDuration, DAY, type Duration, type Instant } from './time.js';

export type SubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'canceled';

export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly interval: Duration;
  readonly currentPeriodEnd: Instant | null;
  readonly nextChargeAt: Instant | null;
  readonly failedAttempts: number;
  readonly canceledAt: Instant | null;
}

export interface RetryPolicy {
  /** Delay before retry n+1 after the n-th consecutive failure; one more failure cancels. */
  readonly retryDelays: readonly Duration[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retryDelays: [DAY, (3 * DAY) as Duration, (5 * DAY) as Duration],
};

export type SubscriptionEvent =
  | { readonly type: 'activated'; readonly at: Instant }
  | { readonly type: 'charge_succeeded'; readonly at: Instant }
  | { readonly type: 'charge_failed'; readonly at: Instant }
  | { readonly type: 'cancel'; readonly at: Instant };

export type SubscriptionTransitionError =
  | {
      readonly code: 'invalid_transition';
      readonly from: SubscriptionStatus;
      readonly event: SubscriptionEvent['type'];
    }
  | { readonly code: 'charge_not_due' };

type TransitionResult = Result<SubscriptionState, SubscriptionTransitionError>;

export function newSubscriptionState(interval: Duration): SubscriptionState {
  return {
    status: 'incomplete',
    interval,
    currentPeriodEnd: null,
    nextChargeAt: null,
    failedAttempts: 0,
    canceledAt: null,
  };
}

export function isChargeDue(state: SubscriptionState, now: Instant): boolean {
  return (
    (state.status === 'active' || state.status === 'past_due') &&
    state.nextChargeAt !== null &&
    now >= state.nextChargeAt
  );
}

export function transitionSubscription(
  state: SubscriptionState,
  event: SubscriptionEvent,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): TransitionResult {
  switch (event.type) {
    case 'activated':
      return state.status === 'incomplete'
        ? ok(startPeriod(state, event.at))
        : invalid(state, event);
    case 'charge_succeeded':
      return chargeSucceeded(state, event);
    case 'charge_failed':
      return chargeFailed(state, event, policy);
    case 'cancel':
      return state.status === 'active' || state.status === 'past_due'
        ? ok({ ...state, status: 'canceled', nextChargeAt: null, canceledAt: event.at })
        : invalid(state, event);
    default:
      return assertNever(event);
  }
}

function startPeriod(state: SubscriptionState, periodStart: Instant): SubscriptionState {
  const periodEnd = addDuration(periodStart, state.interval);
  return {
    ...state,
    status: 'active',
    currentPeriodEnd: periodEnd,
    nextChargeAt: periodEnd,
    failedAttempts: 0,
  };
}

function chargeSucceeded(
  state: SubscriptionState,
  event: Extract<SubscriptionEvent, { type: 'charge_succeeded' }>,
): TransitionResult {
  if (state.status !== 'active' && state.status !== 'past_due') {
    return invalid(state, event);
  }
  if (!isChargeDue(state, event.at) || state.nextChargeAt === null) {
    return err({ code: 'charge_not_due' });
  }
  // No back-charging: a recovered or more-than-one-interval-late charge starts a
  // fresh period at the charge time, mirroring the contract's `charge`.
  const lateByAnInterval = event.at >= addDuration(state.nextChargeAt, state.interval);
  const periodStart =
    state.status === 'past_due' || lateByAnInterval ? event.at : state.nextChargeAt;
  return ok(startPeriod(state, periodStart));
}

function chargeFailed(
  state: SubscriptionState,
  event: Extract<SubscriptionEvent, { type: 'charge_failed' }>,
  policy: RetryPolicy,
): TransitionResult {
  if (state.status !== 'active' && state.status !== 'past_due') {
    return invalid(state, event);
  }
  if (!isChargeDue(state, event.at)) {
    return err({ code: 'charge_not_due' });
  }
  const failedAttempts = state.failedAttempts + 1;
  const retryDelay = policy.retryDelays[failedAttempts - 1];
  if (retryDelay === undefined) {
    return ok({
      ...state,
      status: 'canceled',
      failedAttempts,
      nextChargeAt: null,
      canceledAt: event.at,
    });
  }
  return ok({
    ...state,
    status: 'past_due',
    failedAttempts,
    nextChargeAt: addDuration(event.at, retryDelay),
  });
}

function invalid(state: SubscriptionState, event: SubscriptionEvent): TransitionResult {
  return err({ code: 'invalid_transition', from: state.status, event: event.type });
}
