import { generateMemo } from '@rp/core/memo';
import { fiatToStroops } from '@rp/core/money/convert';
import { fiatAmount } from '@rp/core/money/fiat';
import { formatFxRate } from '@rp/core/money/fx-rate';
import { formatAmount, type Stroops } from '@rp/core/money/stroops';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import { findPaymentById, insertPayment } from '@rp/db/payments';
import type { PaymentRow } from '@rp/db/schema';
import { blindIndex } from '@rp/security/blind-index';
import { encryptField } from '@rp/security/envelope';
import { deriveCheckoutToken } from '@rp/security/tokens';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { assertReturnUrl, idempotencyKey, parseBody, requestHash } from '../request.js';

const CreatePayment = z.object({
  merchant_order_id: z.string().min(1).max(128),
  customer_ref: z.string().min(1).max(256),
  description: z.string().min(1).max(140),
  amount: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    value_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  return_url: z.string().max(2048),
});

const Id = z.object({ id: z.uuid() });

export function paymentView(p: PaymentRow): Record<string, unknown> {
  return {
    id: p.id,
    status: p.status,
    merchant_order_id: p.merchant_order_id,
    amount_due: { asset: p.asset_code, value: formatAmount(p.amount_due_stroops as Stroops) },
    amount_received: {
      asset: p.asset_code,
      value: formatAmount(p.amount_received_stroops as Stroops),
    },
    fiat: {
      currency: p.fiat_currency,
      value_minor: Number(p.fiat_amount_minor),
      fx_rate: p.fx_rate,
    },
    expires_at: p.expires_at.toISOString(),
    confirmed_at: p.confirmed_at?.toISOString() ?? null,
    created_at: p.created_at.toISOString(),
  };
}

export function registerPaymentRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { network, limits, fx: fxConfig } = deps.app;

  app.post('/v1/payments', async (req, reply) => {
    const key = idempotencyKey(req);
    const body = parseBody(req, CreatePayment);
    assertReturnUrl(body.return_url, deps.api.returnUrlOrigins);

    if (!fxConfig.supportedFiat.includes(body.amount.currency)) {
      throw new ApiError(
        'unsupported_currency',
        `Currency ${body.amount.currency} is not accepted`,
      );
    }
    const fiat = fiatAmount(body.amount.currency, BigInt(body.amount.value_minor));
    if (!fiat.ok)
      throw new ApiError(
        'unsupported_currency',
        `Currency ${body.amount.currency} is not accepted`,
      );
    const quote = await deps.fx.rateFor(body.amount.currency);
    if (!quote.ok) {
      throw quote.error === 'fx_unavailable'
        ? new ApiError('fx_unavailable', 'Exchange rate temporarily unavailable')
        : new ApiError('unsupported_currency', `Currency ${body.amount.currency} is not accepted`);
    }
    const due = fiatToStroops(fiat.value, quote.value.rate);
    if (!due.ok || due.value > limits.maxPayment) {
      throw new ApiError(
        'amount_exceeds_limit',
        `Amount exceeds the per-payment limit of ${formatAmount(limits.maxPayment)} USDC`,
      );
    }

    const now = deps.now();
    const id = uuidV7(instant(now.getTime()), deps.randomBytes);
    const { token, hash } = deriveCheckoutToken(deps.api.checkoutTokenKey, `payment:${id}`);
    const result = await insertPayment(deps.db, {
      id,
      idempotency_key: key,
      request_hash: requestHash(req),
      merchant_order_id: body.merchant_order_id,
      customer_ref_enc: encryptField(
        deps.keyring,
        Buffer.from(body.customer_ref, 'utf8'),
        { table: 'payments', column: 'customer_ref_enc', rowId: id },
        deps.randomBytes,
      ),
      customer_ref_bidx: blindIndex(deps.api.blindIndexKey, body.customer_ref),
      description: body.description,
      fiat_currency: body.amount.currency,
      fiat_amount_minor: BigInt(body.amount.value_minor),
      fx_rate: formatFxRate(quote.value.rate),
      asset_code: network.usdc.code,
      asset_issuer: network.usdc.issuer,
      destination: network.merchant,
      memo: generateMemo(deps.randomBytes),
      amount_due_stroops: due.value,
      checkout_token_hash: hash,
      return_url: body.return_url,
      expires_at: new Date(now.getTime() + deps.api.paymentTtlSeconds * 1000),
    });
    if (!result.ok) {
      throw new ApiError(
        'idempotency_conflict',
        'Idempotency-Key was already used with a different request',
      );
    }
    const row = result.value.row;
    // A replay returns the original payment; its token is re-derived from the stored id.
    const checkoutToken = result.value.created
      ? token
      : deriveCheckoutToken(deps.api.checkoutTokenKey, `payment:${row.id}`).token;
    if (!result.value.created) void reply.header('idempotent-replayed', 'true');
    return reply.status(result.value.created ? 201 : 200).send({
      ...paymentView(row),
      checkout_url: `${deps.api.checkoutBaseUrl}/c/${checkoutToken}`,
    });
  });

  app.get('/v1/payments/:id', async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) throw new ApiError('payment_not_found', 'Payment not found');
    const row = await findPaymentById(deps.db, params.data.id);
    if (row === undefined) throw new ApiError('payment_not_found', 'Payment not found');
    return reply.send(paymentView(row));
  });
}
