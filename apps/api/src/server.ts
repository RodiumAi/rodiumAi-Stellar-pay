import helmet from '@fastify/helmet';
import { cryptoRandomBytes } from '@rp/core/random';
import { instant } from '@rp/core/time';
import { uuidV7 } from '@rp/core/uuid-v7';
import { verifyRequest } from '@rp/security/hmac-auth';
import { redactCheckoutPath } from '@rp/security/logger';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ApiDeps } from './deps.js';
import { ApiError, errorBody } from './errors.js';
import { registerCheckoutRoutes, type CheckoutDeps } from './checkout/routes.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerSubscriptionRoutes } from './routes/subscriptions.js';

/** Context §16.3: 16 KB on every endpoint. */
export const BODY_LIMIT_BYTES = 16 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: Buffer;
    apiKeyId: string | null;
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const value = new Map(Object.entries(req.headers)).get(name);
  return typeof value === 'string' ? value : undefined;
};

export function buildServer(deps: ApiDeps, checkout?: CheckoutDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => uuidV7(instant(Date.now()), cryptoRandomBytes),
    // We log one redacted line per request in onResponse instead of Fastify's defaults.
    logController: new LogController({
      requestIdLogLabel: 'trace_id',
      disableRequestLogging: true,
    }),
  });

  void app.register(helmet, { global: true });

  // Decorators may not default to a shared object; each request gets its own empty body.
  app.decorateRequest('rawBody', null as unknown as Buffer);
  app.addHook('onRequest', (req, _reply, done) => {
    req.rawBody = Buffer.alloc(0);
    done();
  });
  app.decorateRequest('apiKeyId', null);

  // Keep the exact bytes: the HMAC covers the raw body (context §9.1).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    done(null, body);
  });
  app.addContentTypeParser('*', (_req, _payload, done) => {
    done(new ApiError('unsupported_media_type', 'Content-Type must be application/json'));
  });

  app.addHook('onResponse', (req, reply, done) => {
    req.log.info(
      {
        req: { method: req.method, url: redactCheckoutPath(req.url) },
        status: reply.statusCode,
        ms: reply.elapsedTime,
      },
      'request',
    );
    done();
  });

  // Authenticate every /v1 call except health, then rate-limit per key.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/v1/') || req.url.startsWith('/v1/health')) return;
    let result;
    try {
      result = await verifyRequest(
        {
          findKey: (id) => {
            const secret = deps.api.hmacKeys.get(id);
            return secret === undefined ? undefined : { id, secret, status: 'active' };
          },
          claimNonce: (keyId, nonce, ttl) => deps.kv.setIfAbsent(`rp:nonce:${keyId}:${nonce}`, ttl),
          nowSeconds: () => Math.floor(deps.now().getTime() / 1000),
        },
        {
          keyId: header(req, 'x-rp-key-id'),
          timestamp: header(req, 'x-rp-timestamp'),
          nonce: header(req, 'x-rp-nonce'),
          signature: header(req, 'x-rp-signature'),
        },
        { method: req.method, pathWithQuery: req.url, body: req.rawBody },
      );
    } catch (error) {
      // Nonce store down: fail closed (context §8).
      req.log.error({ err: error }, 'nonce store unavailable');
      throw new ApiError('service_unavailable', 'Temporarily unavailable');
    }
    if (!result.ok) {
      req.log.warn({ reason: result.error, security: true }, 'request authentication failed');
      throw new ApiError('unauthorized', 'Unauthorized');
    }
    req.apiKeyId = result.value.keyId;
    const decision = await deps.rateLimiter.limit(`rp:rl:api:${result.value.keyId}`);
    if (!decision.allowed) {
      throw Object.assign(new ApiError('rate_limited', 'Too many requests'), {
        retryAfter: decision.retryAfterSeconds,
      });
    }
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ApiError) {
      const retryAfter = (error as ApiError & { retryAfter?: number }).retryAfter;
      if (retryAfter !== undefined) void reply.header('retry-after', String(retryAfter));
      return reply.status(error.status).send(errorBody(error.code, error.message));
    }
    const code = (error as { code?: unknown }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send(errorBody('payload_too_large', 'Request body too large'));
    }
    if (code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(400).send(errorBody('validation_failed', 'Invalid request body'));
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(errorBody('internal_error', 'Internal error'));
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send(errorBody('not_found', 'Not found')),
  );

  registerHealthRoutes(app, deps);
  registerPaymentRoutes(app, deps);
  registerSubscriptionRoutes(app, deps);
  if (checkout !== undefined) registerCheckoutRoutes(app, deps, checkout);
  return app;
}
