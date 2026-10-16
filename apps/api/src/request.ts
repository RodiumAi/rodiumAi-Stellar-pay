import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { ApiError } from './errors.js';

/** Parses the raw JSON body with a Zod schema; any failure is `validation_failed`. */
export function parseBody<T extends z.ZodType>(req: FastifyRequest, schema: T): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    throw new ApiError('validation_failed', 'Body must be valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))];
    throw new ApiError('validation_failed', `Invalid fields: ${fields.join(', ')}`);
  }
  return parsed.data;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** Idempotency-Key is required on POST (context §9.1); scoped per API key. */
export function idempotencyKey(req: FastifyRequest): string {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError(
      'idempotency_key_required',
      'Idempotency-Key header (8-128 chars, [A-Za-z0-9_-]) is required',
    );
  }
  return `${req.apiKeyId ?? 'anon'}:${value}`;
}

/** Hash of what makes two requests "the same": method, path and exact body bytes. */
export function requestHash(req: FastifyRequest): Buffer {
  return createHash('sha256').update(`${req.method}\n${req.url}\n`).update(req.rawBody).digest();
}

export function assertReturnUrl(value: string, allowedOrigins: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError('invalid_return_url', 'return_url is not a valid URL');
  }
  // Exact origin match: scheme, host and port (context §9.2). No credentials allowed.
  if (!allowedOrigins.includes(url.origin) || url.username !== '' || url.password !== '') {
    throw new ApiError('invalid_return_url', 'return_url origin is not allowed');
  }
}
