import { pino, type DestinationStream, type Logger } from 'pino';

/** Field names that must never reach a log line (context §5 Errors and logging). */
const SENSITIVE_KEYS = [
  'secret',
  'password',
  'token',
  'checkoutToken',
  'apiKey',
  'privateKey',
  'authorization',
  'cookie',
  'signature',
  'nonce',
  'customerRef',
  'customer_ref',
  'customerRefEnc',
  'customer_ref_enc',
  'decrypted',
  'plaintext',
  'body',
  'rawBody',
];

const HEADER_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-rp-signature"]',
  'req.headers["x-rp-nonce"]',
  'req.headers["rp-signature"]',
];

export const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
  ...HEADER_PATHS,
];

const CHECKOUT_PATH = /\/c\/[^/?#]+/g;

/** Checkout tokens live in the URL path; keep them out of logs (context §11.2). */
export function redactCheckoutPath(url: string): string {
  return url.replace(CHECKOUT_PATH, '/c/[REDACTED]');
}

export interface LoggerOptions {
  readonly level: string;
  readonly service: string;
}

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
      serializers: {
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          url: req.url === undefined ? undefined : redactCheckoutPath(req.url),
        }),
      },
    },
    destination,
  );
}
