import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

/** Per-request CSP nonce (context §11.3). */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Exactly the §11.3 header set; applied to every /c/* response. */
export function checkoutHeaders(nonce: string | null): Record<string, string> {
  const scriptSrc = nonce === null ? "'none'" : `'nonce-${nonce}' 'strict-dynamic'`;
  return {
    'content-security-policy': [
      "default-src 'none'",
      `script-src ${scriptSrc}`,
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "require-trusted-types-for 'script'",
      'trusted-types default',
      'upgrade-insecure-requests',
    ].join('; '),
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cache-control': 'no-store',
  };
}

export function applyCheckoutHeaders(reply: FastifyReply, nonce: string | null): void {
  for (const [name, value] of Object.entries(checkoutHeaders(nonce)))
    void reply.header(name, value);
}
