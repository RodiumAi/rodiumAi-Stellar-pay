import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** The built documentation site (apps/docs/dist), loaded once at startup. */
export interface DocsSite {
  readonly pages: ReadonlyMap<string, Buffer>;
  readonly assets: ReadonlyMap<string, Buffer>;
}

const TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
};

function walk(dir: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configured build directory
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function loadDocsSite(dir: string): DocsSite {
  const pages = new Map<string, Buffer>();
  const assets = new Map<string, Buffer>();
  for (const file of walk(dir)) {
    const rel = relative(dir, file).split('\\').join('/');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- files listed from the build directory
    const body = readFileSync(file);
    if (rel === 'index.html') pages.set('', body);
    else if (rel.startsWith('docs/') && rel.endsWith('.html')) pages.set(rel.slice(5, -5), body);
    else if (rel.startsWith('assets/')) assets.set(rel.slice(7), body);
  }
  if (!pages.has('')) throw new Error(`docs site in ${dir} has no index.html`);
  return { pages, assets };
}

/** Static pages only: scripts and styles from our origin, no inline code, no framing. */
function docsHeaders(reply: FastifyReply, cache: string): FastifyReply {
  return reply.headers({
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cache-control': cache,
  });
}

/** `/` landing page, `/docs/<page>` and content-hashed `/docs-assets/<file>`. */
export function registerDocsRoutes(app: FastifyInstance, site: DocsSite): void {
  const notFound = (reply: FastifyReply): FastifyReply => {
    reply.callNotFound();
    return reply;
  };
  const page = (slug: string, reply: FastifyReply): FastifyReply => {
    const body = site.pages.get(slug);
    if (body === undefined) return notFound(reply);
    return docsHeaders(reply, 'public, max-age=300').type('text/html; charset=utf-8').send(body);
  };
  app.get('/', (_req, reply) => page('', reply));
  app.get('/docs', (_req, reply) => reply.redirect('/docs/quickstart', 302));
  app.get<{ Params: { slug: string } }>('/docs/:slug', (req, reply) =>
    /^[a-z0-9-]{1,64}$/.test(req.params.slug) ? page(req.params.slug, reply) : notFound(reply),
  );
  app.get<{ Params: { file: string } }>('/docs-assets/:file', (req, reply) => {
    const body = site.assets.get(req.params.file);
    const ext = req.params.file.split('.').pop() ?? '';
    const type = new Map(Object.entries(TYPES)).get(ext);
    if (body === undefined || type === undefined) return notFound(reply);
    // File names carry a content hash, so they never change.
    return docsHeaders(reply, 'public, max-age=31536000, immutable').type(type).send(body);
  });
}
