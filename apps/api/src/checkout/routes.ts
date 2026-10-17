import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatAmount, stroops, type Stroops } from '@rp/core/money/stroops';
import { parseStellarAddress } from '@rp/core/stellar-address';
import { findPaymentByTokenHash } from '@rp/db/payments';
import { findSubscriptionByTokenHash } from '@rp/db/subscriptions';
import type { PaymentRow, SubscriptionRow } from '@rp/db/schema';
import { hashCheckoutToken } from '@rp/security/tokens';
import { buildPayUri } from '@rp/stellar/sep7';
import { guardPaymentTransaction } from '@rp/stellar/xdr-guards';
import { Account, Asset, Memo, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../request.js';
import { applyCheckoutHeaders, newNonce } from './headers.js';
import { renderPaymentPage, type PageAssets } from './page.js';
import {
  prepareSubscription,
  renderSubscriptionPage,
  submitSubscription,
  subscriptionStatusBody,
  type SubscriptionChainClient,
} from './subscription-checkout.js';

/** Context §11.2: a token is valid for 24 h after creation. */
const TOKEN_LIFETIME_MS = 24 * 3600 * 1000;
const OPEN: ReadonlySet<string> = new Set(['pending', 'underpaid']);
const FINAL: ReadonlySet<string> = new Set(['confirmed', 'expired', 'late_paid', 'refunded']);
/** Context §8.2: checkout status cache. */
const STATUS_CACHE_SECONDS = 5;
const SUBMITTED_TTL_SECONDS = 86_400;
const TX_TIMEOUT_SECONDS = 300;
const TX_FEE_STROOPS = '1000';

type Manifest = Readonly<
  Record<
    string,
    {
      readonly file: string;
      readonly css?: readonly string[];
      readonly assets?: readonly string[];
      readonly isEntry?: boolean;
    }
  >
>;

/** Reads the Vite manifest once; only files it lists are ever served (no path traversal). */
export function loadCheckoutAssets(dir: string): {
  readonly page: PageAssets;
  readonly files: ReadonlyMap<string, Buffer>;
} {
  const manifestPath = join(dir, '.vite', 'manifest.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configured build directory
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Manifest;
  const entries = Object.values(manifest);
  const entry = entries.find((e) => e.isEntry === true);
  if (entry === undefined) throw new Error('checkout manifest has no entry');
  const names = new Set(entries.flatMap((e) => [e.file, ...(e.css ?? []), ...(e.assets ?? [])]));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- names come from the manifest
  const files = new Map([...names].map((name) => [name, readFileSync(join(dir, name))] as const));
  return {
    page: {
      script: `/c/assets/${entry.file}`,
      styles: (entry.css ?? []).map((c) => `/c/assets/${c}`),
    },
    files,
  };
}

/** Content types for the checkout's hashed files (the brand font and logo come with the CSS). */
const ASSET_TYPES: ReadonlyMap<string, string> = new Map([
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['woff', 'font/woff'],
  ['svg', 'image/svg+xml'],
]);

const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const PrepareBody = z.object({ address: z.string() });
const SubmitBody = z.object({ xdr: z.string().min(1).max(10_000) });

function notFound(): ApiError {
  // Same answer for unknown, expired and malformed tokens: no existence oracle (§11.2).
  return new ApiError('not_found', 'This payment link is not valid');
}

function remaining(p: PaymentRow): Stroops {
  const left = stroops(p.amount_due_stroops - p.amount_received_stroops);
  return left.ok ? left.value : (0n as Stroops);
}

function paymentStatusBody(payment: PaymentRow): string {
  return JSON.stringify({
    status: payment.status,
    final: FINAL.has(payment.status),
    amount_due: formatAmount(payment.amount_due_stroops as Stroops),
    amount_received: formatAmount(payment.amount_received_stroops as Stroops),
    return_url: FINAL.has(payment.status) ? payment.return_url : null,
  });
}

export interface CheckoutDeps {
  readonly assets: { readonly page: PageAssets; readonly files: ReadonlyMap<string, Buffer> };
  /** Horizon base URL used to load sequence numbers and submit (browser never talks to Stellar). */
  readonly horizonFetch: typeof fetch;
  /** Soroban RPC for the subscription flow (simulate, submit, wait). */
  readonly soroban: SubscriptionChainClient;
}

export function registerCheckoutRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  checkout: CheckoutDeps,
): void {
  const { network } = deps.app;
  const horizon = network.horizonUrl.replace(/\/+$/, '');

  /** Resolves a token to a payment that is within its 24 h lifetime; anything else is 404. */
  type Found =
    | { readonly kind: 'payment'; readonly row: PaymentRow }
    | { readonly kind: 'subscription'; readonly row: SubscriptionRow };

  /** Resolves a token to a payment or subscription within its 24 h lifetime; else 404. */
  const find = async (req: FastifyRequest): Promise<Found> => {
    const params = Token.safeParse(req.params);
    if (!params.success) throw notFound();
    const hash = hashCheckoutToken(params.data.token);
    if (!hash) throw notFound();
    const fresh = (createdAt: Date): boolean =>
      deps.now().getTime() - createdAt.getTime() <= TOKEN_LIFETIME_MS;
    const payment = await findPaymentByTokenHash(deps.db, hash);
    if (payment !== undefined) {
      if (!fresh(payment.created_at)) throw notFound();
      return { kind: 'payment', row: payment };
    }
    const subscription = await findSubscriptionByTokenHash(deps.db, hash);
    if (subscription === undefined || !fresh(subscription.created_at)) throw notFound();
    return { kind: 'subscription', row: subscription };
  };

  const rateLimit = async (req: FastifyRequest): Promise<void> => {
    const decision = await deps.rateLimiter.limit(`rp:rl:ip:${req.ip}`);
    if (!decision.allowed) {
      throw Object.assign(new ApiError('rate_limited', 'Too many requests'), {
        retryAfter: decision.retryAfterSeconds,
      });
    }
  };

  app.register((scope, _opts, done) => {
    scope.addHook('onRequest', async (req, reply) => {
      applyCheckoutHeaders(reply, null);
      await rateLimit(req);
    });

    scope.get('/c/:token', async (req, reply) => {
      const found = await find(req);
      if (found.kind === 'subscription') {
        const sub = found.row;
        if (sub.status !== 'incomplete') throw notFound();
        const nonce = newNonce();
        applyCheckoutHeaders(reply, nonce);
        const { token } = req.params as { token: string };
        return reply.type('text/html; charset=utf-8').send(
          renderSubscriptionPage({
            nonce,
            assets: checkout.assets.page,
            planCode: sub.plan_code,
            price: formatAmount(sub.price_stroops as Stroops),
            intervalSeconds: sub.interval_seconds,
            periods: deps.app.limits.subscriptionApprovePeriods,
            contractId: network.subscriptionContractId,
            networkName: network.name === 'mainnet' ? 'Stellar' : `Stellar ${network.name}`,
            data: {
              kind: 'subscription',
              status: sub.status,
              networkPassphrase: network.passphrase,
              statusUrl: `/c/${token}/status`,
              prepareUrl: `/c/${token}/prepare`,
              submitUrl: `/c/${token}/submit`,
            },
          }),
        );
      }
      const payment = found.row;
      // A final payment has nothing left to pay (§11.2); the status endpoint still answers.
      if (!OPEN.has(payment.status)) throw notFound();
      const nonce = newNonce();
      applyCheckoutHeaders(reply, nonce);
      const left = remaining(payment);
      const { token } = req.params as { token: string };
      const html = renderPaymentPage({
        nonce,
        assets: checkout.assets.page,
        description: payment.description,
        amount: formatAmount(left),
        asset: payment.asset_code,
        assetIssuer: payment.asset_issuer,
        destination: payment.destination,
        memo: payment.memo,
        payUri: buildPayUri({
          destination: payment.destination,
          amount: left,
          assetCode: payment.asset_code,
          assetIssuer: payment.asset_issuer,
          memo: payment.memo,
          networkPassphrase: network.passphrase,
        }),
        networkName: network.name === 'mainnet' ? 'Stellar' : `Stellar ${network.name}`,
        expiresAt: payment.expires_at.toISOString(),
        statusText:
          payment.status === 'underpaid'
            ? 'Partially paid — send the remaining amount'
            : 'Waiting for payment',
        data: {
          kind: 'payment',
          status: payment.status,
          networkPassphrase: network.passphrase,
          statusUrl: `/c/${token}/status`,
          prepareUrl: `/c/${token}/prepare`,
          submitUrl: `/c/${token}/submit`,
        },
      });
      return reply.type('text/html; charset=utf-8').send(html);
    });

    scope.get('/c/:token/status', async (req, reply) => {
      const found = await find(req);
      const cacheKey = `rp:status:${found.row.id}`;
      let body: string | null = null;
      try {
        body = await deps.kv.get(cacheKey);
      } catch {
        // Cache down: read Postgres (fail open, §8.2).
      }
      if (body === null) {
        body =
          found.kind === 'subscription'
            ? subscriptionStatusBody(found.row)
            : paymentStatusBody(found.row);
        await deps.kv.set(cacheKey, body, STATUS_CACHE_SECONDS).catch(() => undefined);
      }
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
      void reply.header('etag', etag);
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.type('application/json').send(body);
    });

    scope.post('/c/:token/prepare', async (req, reply) => {
      const found = await find(req);
      if (found.kind === 'subscription') {
        if (found.row.status !== 'incomplete')
          throw new ApiError('invalid_state', 'This subscription is already set up');
        return reply.send(await prepareSubscription(deps, checkout.soroban, found.row, req));
      }
      const payment = found.row;
      if (!OPEN.has(payment.status))
        throw new ApiError('invalid_state', 'This payment is no longer open');
      const { address } = parseBody(req, PrepareBody);
      if (!parseStellarAddress(address).ok || !StrKey.isValidEd25519PublicKey(address)) {
        throw new ApiError('validation_failed', 'Invalid wallet address');
      }
      const res = await checkout.horizonFetch(
        `${horizon}/accounts/${encodeURIComponent(address)}`,
        {
          signal: AbortSignal.timeout(5000),
        },
      );
      if (res.status === 404)
        throw new ApiError('validation_failed', 'This wallet account is not active on the network');
      if (!res.ok) throw new ApiError('service_unavailable', 'Network temporarily unavailable');
      const { sequence } = z
        .object({ sequence: z.string().regex(/^\d+$/) })
        .parse(await res.json());
      const now = Math.floor(deps.now().getTime() / 1000);
      const tx = new TransactionBuilder(new Account(address, sequence), {
        fee: TX_FEE_STROOPS,
        networkPassphrase: network.passphrase,
        memo: Memo.text(payment.memo),
        timebounds: { minTime: 0, maxTime: now + TX_TIMEOUT_SECONDS },
      })
        .addOperation(
          Operation.payment({
            destination: payment.destination,
            asset: new Asset(payment.asset_code, payment.asset_issuer),
            amount: formatAmount(remaining(payment)),
          }),
        )
        .build();
      return reply.send({ xdr: tx.toXdr(), network_passphrase: network.passphrase });
    });

    scope.post('/c/:token/submit', async (req, reply: FastifyReply) => {
      const found = await find(req);
      if (found.kind === 'subscription') {
        if (found.row.status !== 'incomplete')
          throw new ApiError('invalid_state', 'This subscription is already set up');
        return submitSubscription(deps, checkout.soroban, found.row, req, reply);
      }
      const payment = found.row;
      if (!OPEN.has(payment.status))
        throw new ApiError('invalid_state', 'This payment is no longer open');
      const { xdr } = parseBody(req, SubmitBody);
      const guard = guardPaymentTransaction(xdr, {
        networkPassphrase: network.passphrase,
        maxFeeStroops: network.maxFeeStroops,
        nowSeconds: Math.floor(deps.now().getTime() / 1000),
        merchant: payment.destination,
        usdc: { code: payment.asset_code, issuer: payment.asset_issuer },
        amount: remaining(payment),
        memo: payment.memo,
      });
      if (!guard.ok) {
        req.log.warn(
          { security: true, reason: guard.error, payment_id: payment.id },
          'rejected checkout transaction',
        );
        throw new ApiError(
          'invalid_transaction',
          'This transaction does not match the payment request',
        );
      }
      // Never relay the same transaction twice (§13.3); fail closed if the store is down.
      let first: boolean;
      try {
        first = await deps.kv.setIfAbsent(
          `rp:submitted:${guard.value.hash}`,
          SUBMITTED_TTL_SECONDS,
        );
      } catch {
        throw new ApiError('service_unavailable', 'Temporarily unavailable');
      }
      if (!first) throw new ApiError('already_submitted', 'This transaction was already submitted');
      const res = await checkout.horizonFetch(`${horizon}/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: xdr }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as {
          extras?: { result_codes?: unknown };
        };
        req.log.warn(
          { payment_id: payment.id, result_codes: detail.extras?.result_codes },
          'network rejected transaction',
        );
        throw new ApiError('submit_failed', 'The network rejected the transaction');
      }
      return reply.send({ hash: guard.value.hash, status: 'submitted' });
    });

    scope.get('/c/assets/:file', (req, reply) => {
      const { file } = req.params as { file: string };
      const content = checkout.assets.files.get(file);
      const type = ASSET_TYPES.get(file.split('.').pop() ?? '');
      if (content === undefined || type === undefined) throw new ApiError('not_found', 'Not found');
      // Hashed names: safe to cache; still same-origin only (§11.3 CORP).
      void reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.type(type).send(content);
    });

    done();
  });
}
