/** Stable error codes returned to clients (context §9.2): no stack traces, no internals. */
export type ErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'payment_not_found'
  | 'subscription_not_found'
  | 'idempotency_key_required'
  | 'idempotency_conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unsupported_currency'
  | 'amount_exceeds_limit'
  | 'invalid_return_url'
  | 'unknown_plan'
  | 'invalid_state'
  | 'rate_limited'
  | 'fx_unavailable'
  | 'service_unavailable'
  | 'not_found'
  | 'internal_error';

const STATUS: ReadonlyMap<ErrorCode, number> = new Map<ErrorCode, number>([
  ['validation_failed', 400],
  ['idempotency_key_required', 400],
  ['unauthorized', 401],
  ['payment_not_found', 404],
  ['subscription_not_found', 404],
  ['not_found', 404],
  ['idempotency_conflict', 409],
  ['invalid_state', 409],
  ['payload_too_large', 413],
  ['unsupported_media_type', 415],
  ['unsupported_currency', 422],
  ['amount_exceeds_limit', 422],
  ['invalid_return_url', 422],
  ['unknown_plan', 422],
  ['rate_limited', 429],
  ['internal_error', 500],
  ['fx_unavailable', 503],
  ['service_unavailable', 503],
]);

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS.get(code) ?? 500;
  }
}

export function errorBody(
  code: ErrorCode,
  message: string,
): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}
