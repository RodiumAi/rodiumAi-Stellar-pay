import { describe, expect, it } from 'vitest';
import { createLogger, redactCheckoutPath } from './logger.js';

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => void lines.push(line) } };
}

const SECRETS = [
  's3cr3t-value',
  'tok_abcdef',
  'cust-42@example.com',
  'sig-xyz',
  'nonce-123',
  'PRIVATE',
];

describe('logger redaction (context §5)', () => {
  it('never emits secrets, tokens, signatures, bodies or customer refs', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', service: 'test' }, stream);
    log.info(
      {
        secret: SECRETS[0],
        token: SECRETS[1],
        customer_ref: SECRETS[2],
        payment: { customerRef: SECRETS[2], checkoutToken: SECRETS[1] },
        deep: { nested: { signature: SECRETS[3], privateKey: SECRETS[5] } },
        body: { anything: SECRETS[0] },
        nonce: SECRETS[4],
        payment_id: '0199e5c2-0000-7000-8000-000000000001',
      },
      'event',
    );
    const out = lines.join('');
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).toContain('0199e5c2-0000-7000-8000-000000000001');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts checkout tokens from request URLs and drops request headers', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', service: 'test' }, stream);
    log.info({
      req: {
        method: 'GET',
        url: '/c/tok_abcdef/status?x=1',
        headers: { authorization: 'Bearer s3cr3t-value' },
      },
    });
    const out = lines.join('');
    expect(out).toContain('/c/[REDACTED]/status?x=1');
    expect(out).not.toContain('tok_abcdef');
    expect(out).not.toContain('s3cr3t-value');
  });

  it('redactCheckoutPath leaves other paths alone', () => {
    expect(redactCheckoutPath('/v1/payments')).toBe('/v1/payments');
    expect(redactCheckoutPath('/c/abc')).toBe('/c/[REDACTED]');
  });
});
