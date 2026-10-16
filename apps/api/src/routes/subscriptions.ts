import { formatAmount, type Stroops } from '@rp/core/money/stroops';
import type { SubscriptionStatus } from '@rp/core/subscription';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import { enqueueEvent } from '@rp/db/outbox';
import type { SubscriptionRow } from '@rp/db/schema';
import {
  findSubscriptionById,
  insertSubscription,
  transitionSubscription,
} from '@rp/db/subscriptions';
import { blindIndex } from '@rp/security/blind-index';
import { encryptField } from '@rp/security/envelope';
import { deriveCheckoutToken } from '@rp/security/tokens';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { assertReturnUrl, idempotencyKey, parseBody, requestHash } from '../request.js';

const CreateSubscription = z.object({
  merchant_subscription_ref: z.string().min(1).max(128),
  customer_ref: z.string().min(1).max(256),
  plan_code: z.string().min(1).max(64),
  return_url: z.string().max(2048),
});

const Id = z.object({ id: z.uuid() });

const CANCELABLE: readonly SubscriptionStatus[] = ['incomplete', 'active', 'past_due'];

export function subscriptionView(s: SubscriptionRow): Record<string, unknown> {
  return {
    id: s.id,
    status: s.status,
    merchant_subscription_ref: s.merchant_subscription_ref,
    plan_code: s.plan_code,
    price: { asset: 'USDC', value: formatAmount(s.price_stroops as Stroops) },
    interval_seconds: s.interval_seconds,
    current_period_end: s.current_period_end?.toISOString() ?? null,
    next_charge_at: s.next_charge_at?.toISOString() ?? null,
    canceled_at: s.canceled_at?.toISOString() ?? null,
    created_at: s.created_at.toISOString(),
  };
}

export function registerSubscriptionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v1/subscriptions', async (req, reply) => {
    const key = idempotencyKey(req);
    const body = parseBody(req, CreateSubscription);
    assertReturnUrl(body.return_url, deps.api.returnUrlOrigins);
    const plan = deps.api.plans.find((p) => p.code === body.plan_code);
    if (plan === undefined) throw new ApiError('unknown_plan', `Unknown plan ${body.plan_code}`);
    if (plan.price > deps.app.limits.maxSubscriptionPrice) {
      throw new ApiError('amount_exceeds_limit', 'Plan price exceeds the subscription price limit');
    }

    const id = uuidV7(instant(deps.now().getTime()), deps.randomBytes);
    const { token, hash } = deriveCheckoutToken(deps.api.checkoutTokenKey, `subscription:${id}`);
    const result = await insertSubscription(deps.db, {
      id,
      idempotency_key: key,
      request_hash: requestHash(req),
      merchant_subscription_ref: body.merchant_subscription_ref,
      customer_ref_enc: encryptField(
        deps.keyring,
        Buffer.from(body.customer_ref, 'utf8'),
        { table: 'subscriptions', column: 'customer_ref_enc', rowId: id },
        deps.randomBytes,
      ),
      customer_ref_bidx: blindIndex(deps.api.blindIndexKey, body.customer_ref),
      plan_code: plan.code,
      contract_plan_id: plan.contractPlanId,
      price_stroops: plan.price,
      interval_seconds: plan.intervalSeconds,
      checkout_token_hash: hash,
      return_url: body.return_url,
    });
    if (!result.ok) {
      throw new ApiError(
        'idempotency_conflict',
        'Idempotency-Key was already used with a different request',
      );
    }
    const row = result.value.row;
    const checkoutToken = result.value.created
      ? token
      : deriveCheckoutToken(deps.api.checkoutTokenKey, `subscription:${row.id}`).token;
    if (!result.value.created) void reply.header('idempotent-replayed', 'true');
    return reply.status(result.value.created ? 201 : 200).send({
      ...subscriptionView(row),
      checkout_url: `${deps.api.checkoutBaseUrl}/c/${checkoutToken}`,
    });
  });

  app.get('/v1/subscriptions/:id', async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) throw new ApiError('subscription_not_found', 'Subscription not found');
    const row = await findSubscriptionById(deps.db, params.data.id);
    if (row === undefined) throw new ApiError('subscription_not_found', 'Subscription not found');
    return reply.send(subscriptionView(row));
  });

  /**
   * Marks the subscription canceled so the keeper never charges it again. The on-chain
   * allowance stays until it expires or the user revokes it in their wallet (§14.2).
   */
  app.post('/v1/subscriptions/:id/cancel', async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) throw new ApiError('subscription_not_found', 'Subscription not found');
    const row = await deps.db.transaction().execute(async (tx) => {
      const current = await findSubscriptionById(tx, params.data.id);
      if (current === undefined)
        throw new ApiError('subscription_not_found', 'Subscription not found');
      if (current.status === 'canceled') return current;
      if (!CANCELABLE.includes(current.status))
        throw new ApiError('invalid_state', 'Subscription cannot be canceled');
      const updated = await transitionSubscription(tx, current.id, current.status, {
        status: 'canceled',
        canceled_at: deps.now(),
      });
      if (updated === undefined)
        throw new ApiError('invalid_state', 'Subscription changed concurrently; retry');
      await enqueueEvent(tx, {
        id: uuidV7(instant(deps.now().getTime()), deps.randomBytes),
        type: 'subscription.canceled',
        aggregateId: updated.id,
        payload: {
          subscription_id: updated.id,
          merchant_subscription_ref: updated.merchant_subscription_ref,
          canceled_by: 'merchant',
        },
      });
      return updated;
    });
    return reply.send(subscriptionView(row));
  });
}
