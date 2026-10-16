import { formatAmount, type Stroops } from '@rp/core/money/stroops';
import { parseStellarAddress } from '@rp/core/stellar-address';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import { enqueueEvent } from '@rp/db/outbox';
import type { SubscriptionRow } from '@rp/db/schema';
import { activateSubscription, recordSubscribeSubmission } from '@rp/db/subscriptions';
import { submitAndWait, type SorobanClient } from '@rp/stellar/soroban';
import { buildSubscribeTransaction, type SubscribeClient } from '@rp/stellar/subscribe-tx';
import { guardSubscribeTransaction } from '@rp/stellar/xdr-guards';
import {
  FeeBumpTransaction,
  scValToNative,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../request.js';
import { escapeHtml, jsonForScript, type PageAssets } from './page.js';

const SUBMITTED_TTL_SECONDS = 86_400;
const TX_TIMEOUT_SECONDS = 300;

export type SubscriptionChainClient = SorobanClient & SubscribeClient;

function intervalText(seconds: number): string {
  if (seconds % 2_592_000 === 0)
    return seconds === 2_592_000
      ? 'every 30 days'
      : `every ${String((seconds / 2_592_000) * 30)} days`;
  if (seconds % 86_400 === 0)
    return seconds === 86_400 ? 'every day' : `every ${String(seconds / 86_400)} days`;
  return `every ${String(seconds)} seconds`;
}

export function renderSubscriptionPage(m: {
  readonly nonce: string;
  readonly assets: PageAssets;
  readonly planCode: string;
  readonly price: string;
  readonly intervalSeconds: number;
  readonly periods: number;
  readonly contractId: string;
  readonly networkName: string;
  readonly data: unknown;
}): string {
  const styles = m.assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('');
  const every = intervalText(m.intervalSeconds);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Subscribe — ${escapeHtml(m.price)} USDC ${escapeHtml(every)} — RodiumAI</title>
${styles}
</head>
<body>
<main>
<section class="card" aria-labelledby="title">
<h1 id="title">Subscribe to ${escapeHtml(m.planCode)}</h1>
<p class="amount" aria-label="Price">${escapeHtml(m.price)} USDC ${escapeHtml(every)}</p>
<dl>
<dt>Network</dt><dd>${escapeHtml(m.networkName)}</dd>
<dt>First charge</dt><dd>${escapeHtml(m.price)} USDC today</dd>
<dt>You approve</dt><dd>Up to ${String(m.periods)} future charges of ${escapeHtml(m.price)} USDC</dd>
<dt>Contract</dt><dd>${escapeHtml(m.contractId)}</dd>
</dl>
<p class="hint">One signature pays the first period and approves the future charges. You can cancel anytime, or revoke the approval in your wallet.</p>
<div class="actions">
<button type="button" id="pay-freighter">Subscribe with Freighter</button>
</div>
<p id="wallet-message" class="hint" role="status" aria-live="polite"></p>
<p id="status" class="status" role="status" aria-live="polite">Waiting for your signature</p>
<p class="visually-hidden" id="received"></p>
</section>
</main>
<script type="application/json" id="rp-checkout">${jsonForScript(m.data)}</script>
<script type="module" nonce="${escapeHtml(m.nonce)}" src="${escapeHtml(m.assets.script)}"></script>
</body>
</html>`;
}

/** `live_until_ledger`, the 4th `subscribe` argument (already checked by the guard). */
function liveUntilOf(tx: Transaction): number | null {
  const op = tx.operations[0];
  if (op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract')
    return null;
  const arg = op.func.invokeContract.args[3];
  if (arg === undefined) return null;
  const value: unknown = scValToNative(arg);
  return typeof value === 'number' ? value : null;
}

export function subscriptionStatusBody(s: SubscriptionRow): string {
  const final = s.status !== 'incomplete';
  return JSON.stringify({
    status: s.status,
    final,
    amount_due: formatAmount(s.price_stroops as Stroops),
    amount_received: '',
    return_url: final ? s.return_url : null,
  });
}

/** Builds and simulates `subscribe` for the connected wallet (§11.1 subscription flow). */
export async function prepareSubscription(
  deps: ApiDeps,
  client: SubscriptionChainClient,
  sub: SubscriptionRow,
  req: FastifyRequest,
): Promise<{ xdr: string; network_passphrase: string }> {
  const { address } = parseBody(req, z.object({ address: z.string() }));
  if (!parseStellarAddress(address).ok || !StrKey.isValidEd25519PublicKey(address)) {
    throw new ApiError('validation_failed', 'Invalid wallet address');
  }
  const { network, limits } = deps.app;
  try {
    const built = await buildSubscribeTransaction(client, {
      contractId: network.subscriptionContractId,
      subscriber: address,
      planId: sub.contract_plan_id,
      periods: limits.subscriptionApprovePeriods,
      intervalSeconds: sub.interval_seconds,
      networkPassphrase: network.passphrase,
      baseFee: '1000',
      timeoutSeconds: TX_TIMEOUT_SECONDS,
    });
    return { xdr: built.xdr, network_passphrase: network.passphrase };
  } catch (error) {
    req.log.warn({ err: error, subscription_id: sub.id }, 'subscribe simulation failed');
    throw new ApiError(
      'validation_failed',
      'This wallet cannot subscribe right now (check its USDC balance and trustline)',
    );
  }
}

/**
 * Validates (§13.3), submits once, waits for the result and activates the subscription
 * with the on-chain id. If the result is slow, the worker's event sync activates it later.
 */
export async function submitSubscription(
  deps: ApiDeps,
  client: SubscriptionChainClient,
  sub: SubscriptionRow,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { xdr } = parseBody(req, z.object({ xdr: z.string().min(1).max(20_000) }));
  const { network, limits } = deps.app;
  let subscriber: string;
  try {
    const decoded = TransactionBuilder.fromXdr(xdr, network.passphrase);
    if (decoded instanceof FeeBumpTransaction) throw new Error('fee bump');
    subscriber = decoded.source;
  } catch {
    throw new ApiError('invalid_transaction', 'This transaction does not match the subscription');
  }
  const guard = guardSubscribeTransaction(xdr, {
    networkPassphrase: network.passphrase,
    maxFeeStroops: network.maxSorobanFeeStroops,
    nowSeconds: Math.floor(deps.now().getTime() / 1000),
    contractId: network.subscriptionContractId,
    planId: sub.contract_plan_id,
    periods: limits.subscriptionApprovePeriods,
    subscriber,
  });
  if (!guard.ok) {
    req.log.warn(
      { security: true, reason: guard.error, subscription_id: sub.id },
      'rejected checkout transaction',
    );
    throw new ApiError('invalid_transaction', 'This transaction does not match the subscription');
  }
  let first: boolean;
  try {
    first = await deps.kv.setIfAbsent(`rp:submitted:${guard.value.hash}`, SUBMITTED_TTL_SECONDS);
  } catch {
    throw new ApiError('service_unavailable', 'Temporarily unavailable');
  }
  if (!first) throw new ApiError('already_submitted', 'This transaction was already submitted');

  const liveUntil = liveUntilOf(guard.value.transaction);
  // Before sending: if our wait below times out, the worker activates the subscription from
  // the contract's `sub_created` event, matched by this transaction hash.
  await recordSubscribeSubmission(deps.db, sub.id, {
    txHash: Buffer.from(guard.value.hash, 'hex'),
    subscriberAddress: subscriber,
    allowanceExpiresLedger: liveUntil ?? 0,
  });

  const outcome = await submitAndWait(client, xdr, network.passphrase);
  if (outcome.status === 'failed') {
    req.log.warn(
      { subscription_id: sub.id, detail: outcome.detail },
      'subscribe transaction failed',
    );
    throw new ApiError('submit_failed', 'The network rejected the transaction');
  }
  if (outcome.status === 'pending' || typeof outcome.returnValue !== 'bigint') {
    return reply.send({ hash: outcome.hash, status: 'submitted' });
  }
  const contractId = outcome.returnValue;
  await deps.db.transaction().execute(async (tx) => {
    const activated = await activateSubscription(tx, sub.id, {
      subscriberAddress: subscriber,
      contractSubscriptionId: contractId,
      allowanceExpiresLedger: liveUntil ?? 0,
    });
    if (activated === undefined) return;
    await enqueueEvent(tx, {
      id: uuidV7(instant(deps.now().getTime()), deps.randomBytes),
      type: 'subscription.activated',
      aggregateId: sub.id,
      payload: {
        subscription_id: sub.id,
        merchant_subscription_ref: sub.merchant_subscription_ref,
        plan_code: sub.plan_code,
        contract_subscription_id: contractId.toString(),
        tx_hash: outcome.hash,
      },
    });
  });
  return reply.send({ hash: outcome.hash, status: 'active' });
}
