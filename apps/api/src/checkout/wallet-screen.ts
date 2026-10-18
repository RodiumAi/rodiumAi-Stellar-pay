import type { FastifyRequest } from 'fastify';
import type { ApiDeps } from '../deps.js';
import { ApiError } from '../errors.js';

/**
 * Refuses a screened wallet before anything is built for it to sign. The message is generic
 * on purpose (no hint why); the reason is only in the logs.
 */
export function assertWalletAllowed(deps: ApiDeps, req: FastifyRequest, address: string): void {
  if (!deps.isBlockedWallet(address)) return;
  req.log.warn({ alert: 'sanctioned_wallet', address }, 'checkout refused a blocked wallet');
  throw new ApiError('validation_failed', 'This wallet cannot be used for payment');
}
