import type { Brand } from './brand.js';
import type { RandomBytes } from './random.js';
import { err, ok, type Result } from './result.js';
import type { Instant } from './time.js';
import { isUuidV7, uuidV7 } from './uuid-v7.js';

export type PaymentId = Brand<string, 'PaymentId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;

export function newPaymentId(now: Instant, randomBytes: RandomBytes): PaymentId {
  return uuidV7(now, randomBytes) as PaymentId;
}

export function newSubscriptionId(now: Instant, randomBytes: RandomBytes): SubscriptionId {
  return uuidV7(now, randomBytes) as SubscriptionId;
}

export function parsePaymentId(value: string): Result<PaymentId, 'invalid_id'> {
  return isUuidV7(value) ? ok(value as PaymentId) : err('invalid_id');
}

export function parseSubscriptionId(value: string): Result<SubscriptionId, 'invalid_id'> {
  return isUuidV7(value) ? ok(value as SubscriptionId) : err('invalid_id');
}
