import rateLimit from '@fastify/rate-limit';
import type { NetworkName } from '@rp/config/network';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import type { AlbAuthError, AlbIdentity } from './alb-auth.js';
import type { Result } from '@rp/core/result';
import { isUuid, PAGE_SIZE, PAYMENT_STATUSES, type AdminQueries } from './queries.js';
import type { StatusProbes } from './status.js';
import { ADMIN_CSS } from './styles.js';
import {
  errorPage,
  overviewPage,
  paymentPage,
  paymentsPage,
  receiptsPage,
  webhooksPage,
  type PageContext,
} from './views.js';

export interface AdminDeps {
  readonly basePath: string;
  readonly network: NetworkName;
  readonly treasury: string;
  readonly allowedEmails: ReadonlySet<string>;
  /** Cognito logout URL; null hides "Sign out" (dev mode). */
  readonly logoutUrl: string | null;
  /** Who is signed in, from the request's `x-amzn-oidc-data` header. */
  readonly authenticate: (token: string | undefined) => Promise<Result<AlbIdentity, AlbAuthError>>;
  readonly queries: AdminQueries;
  readonly probes: StatusProbes;
  readonly logger: FastifyBaseLogger;
  readonly now: () => Date;
  /** Requests per client IP per minute (default 120). */
  readonly rateLimitPerMinute?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminEmail: string | null;
  }
}

/** Strict: no scripts at all, styles only from our own stylesheet, never framed. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store',
};

/** The load balancer keeps the login session in these cookies (split when large). */
const ALB_SESSION_COOKIES = [0, 1, 2, 3].map((i) => `AWSELBAuthSessionCookie-${String(i)}`);

const MAX_SEARCH = 128;

function queryParam(query: unknown, name: string): string | null {
  if (typeof query !== 'object' || query === null) return null;
  const value: unknown = new Map<string, unknown>(Object.entries(query)).get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sendHtml(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(body);
}

export function buildServer(deps: AdminDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true }),
    // Only the load balancer can reach the task; it appends the client address.
    trustProxy: (_address, hop) => hop === 0,
  });
  const base = deps.basePath;
  const ctxFor = (email: string): PageContext => ({
    basePath: base,
    network: deps.network,
    treasury: deps.treasury,
    email,
    logoutHref: deps.logoutUrl === null ? null : `${base}/logout`,
  });

  // Every route, the health check included, is rate-limited per client address. Registered
  // before the hooks and routes so it visibly covers all of them (the sign-in check included).
  void app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 120,
    timeWindow: '1 minute',
  });

  app.decorateRequest('adminEmail', null);

  app.addHook('onSend', (_req, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value);
    done(null, payload);
  });

  app.addHook('onResponse', (req, reply, done) => {
    // Who opened what: the access trail for the dashboard (route templates, no query values).
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        admin: req.adminEmail,
        ms: reply.elapsedTime,
      },
      'admin request',
    );
    done();
  });

  // Every dashboard path requires a verified, allow-listed identity.
  app.addHook('preHandler', async (req, reply) => {
    if (req.url !== base && !req.url.startsWith(`${base}/`) && !req.url.startsWith(`${base}?`))
      return;
    const header = req.headers['x-amzn-oidc-data'];
    const result = await deps.authenticate(typeof header === 'string' ? header : undefined);
    if (!result.ok) {
      req.log.warn({ reason: result.error, security: true }, 'admin authentication failed');
      return sendHtml(reply, 401, errorPage(null, 401, 'Sign-in required.'));
    }
    if (!deps.allowedEmails.has(result.value.email)) {
      req.log.warn({ admin: result.value.email, security: true }, 'admin not on allow-list');
      return sendHtml(reply, 403, errorPage(null, 403, 'This account has no access.'));
    }
    req.adminEmail = result.value.email;
  });

  const email = (req: { adminEmail: string | null }): string => req.adminEmail ?? '';

  void app.register((scope, _opts, done) => {
    // Load balancer health check; the public listener rule only forwards the dashboard path.
    scope.get('/health/live', (_req, reply) => reply.send({ status: 'ok' }));

    scope.get(`${base}/admin.css`, (_req, reply) =>
      reply.type('text/css; charset=utf-8').send(ADMIN_CSS),
    );

    const overview = async (
      req: { adminEmail: string | null },
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const [o, treasury, api] = await Promise.all([
        deps.queries.overview(),
        deps.probes.treasury(),
        deps.probes.apiReady(),
      ]);
      return sendHtml(reply, 200, overviewPage(ctxFor(email(req)), o, treasury, api, deps.now()));
    };
    scope.get(base, overview);
    scope.get(`${base}/`, overview);

    scope.get(`${base}/payments`, async (req, reply) => {
      const statusParam = queryParam(req.query, 'status');
      const status = PAYMENT_STATUSES.find((s) => s === statusParam) ?? null;
      const search = queryParam(req.query, 'q')?.slice(0, MAX_SEARCH) ?? null;
      const beforeParam = queryParam(req.query, 'before');
      const filter = {
        status,
        search,
        before: beforeParam !== null && isUuid(beforeParam) ? beforeParam.toLowerCase() : null,
      };
      const rows = await deps.queries.payments(filter);
      return sendHtml(reply, 200, paymentsPage(ctxFor(email(req)), filter, rows, PAGE_SIZE));
    });

    scope.get<{ Params: { id: string } }>(`${base}/payments/:id`, async (req, reply) => {
      const payment = await deps.queries.payment(req.params.id);
      if (payment === null)
        return sendHtml(reply, 404, errorPage(ctxFor(email(req)), 404, 'No such payment.'));
      return sendHtml(reply, 200, paymentPage(ctxFor(email(req)), payment));
    });

    scope.get(`${base}/receipts`, async (req, reply) => {
      const m = queryParam(req.query, 'match');
      const match = m === 'ignored' || m === 'matched' ? m : 'unmatched';
      const before = queryParam(req.query, 'before');
      const rows = await deps.queries.receipts(
        match,
        before !== null && isUuid(before) ? before.toLowerCase() : null,
      );
      return sendHtml(reply, 200, receiptsPage(ctxFor(email(req)), match, rows, PAGE_SIZE));
    });

    scope.get(`${base}/webhooks`, async (req, reply) => {
      const s = queryParam(req.query, 'status');
      const status = s === 'pending' || s === 'delivered' ? s : 'dead';
      const before = queryParam(req.query, 'before');
      const rows = await deps.queries.webhooks(
        status,
        before !== null && isUuid(before) ? before.toLowerCase() : null,
      );
      return sendHtml(reply, 200, webhooksPage(ctxFor(email(req)), status, rows, PAGE_SIZE));
    });

    scope.get(`${base}/logout`, (_req, reply) => {
      if (deps.logoutUrl === null) return reply.redirect(base);
      void reply.header(
        'set-cookie',
        ALB_SESSION_COOKIES.map(
          (c) =>
            `${c}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`,
        ),
      );
      return reply.redirect(deps.logoutUrl);
    });
    done();
  });

  app.setNotFoundHandler((_req, reply) => sendHtml(reply, 404, errorPage(null, 404, 'Not found.')));

  app.setErrorHandler((error: unknown, req, reply) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (status === 429) {
      req.log.warn({ security: true }, 'admin rate limit hit');
      return sendHtml(reply, 429, errorPage(null, 429, 'Too many requests; wait a minute.'));
    }
    req.log.error({ err: error }, 'admin request failed');
    return sendHtml(reply, 500, errorPage(null, 500, 'Something went wrong; see the logs.'));
  });

  return app;
}
