import type { AppConfig } from '@rp/config/app-config';
import type { RandomBytes } from '@rp/core/random';
import type { Db } from '@rp/db/connection';
import type { Keyring } from '@rp/security/envelope';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiConfig } from './api-config.js';
import type { FxProvider } from './fx.js';
import type { KvStore } from './kv.js';
import type { RateLimiter } from './rate-limit.js';

export interface HealthChecks {
  readonly database: () => Promise<boolean>;
  readonly redis: () => Promise<boolean>;
  readonly ledger: () => Promise<boolean>;
}

/** Everything the API needs, passed in explicitly (context §5: no hidden singletons). */
export interface ApiDeps {
  readonly app: AppConfig;
  readonly api: ApiConfig;
  readonly db: Db;
  readonly kv: KvStore;
  readonly rateLimiter: RateLimiter;
  readonly fx: FxProvider;
  readonly keyring: Keyring;
  readonly randomBytes: RandomBytes;
  readonly now: () => Date;
  readonly logger: FastifyBaseLogger;
  readonly health: HealthChecks;
  /** Wallet screening (OFAC list + operator block list). */
  readonly isBlockedWallet: (address: string) => boolean;
}
