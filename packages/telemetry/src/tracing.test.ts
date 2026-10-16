import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, describe, expect, it } from 'vitest';
import { startServerSpan, startTracing, traceHeaders, withSpan } from './tracing.js';

const exporter = new InMemorySpanExporter();
const tracing = startTracing({
  service: 'test',
  env: {},
  processor: new SimpleSpanProcessor(exporter),
});
afterAll(() => tracing.shutdown());

describe('tracing (context §18)', () => {
  it('is off without an OTLP endpoint', async () => {
    const off = startTracing({ service: 'x', env: { OTEL_EXPORTER_OTLP_ENDPOINT: '' } });
    expect(off.enabled).toBe(false);
    await off.shutdown();
  });

  it('nests spans and propagates a W3C traceparent to the next service', async () => {
    exporter.reset();
    let headers: Record<string, string> = {};
    await withSpan('job charge', { job: 'charge' }, async () => {
      await withSpan('signer.sign', {}, () => {
        headers = traceHeaders();
        return Promise.resolve();
      });
    });
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const server = startServerSpan('POST /v1/sign', headers, {});
    server.end();
    const spans = exporter.getFinishedSpans();
    const [job, sign, srv] = ['job charge', 'signer.sign', 'POST /v1/sign'].map((n) =>
      spans.find((s) => s.name === n),
    );
    expect(sign?.spanContext().traceId).toBe(job?.spanContext().traceId);
    expect(srv?.spanContext().traceId).toBe(job?.spanContext().traceId);
    expect(srv?.parentSpanContext?.spanId).toBe(sign?.spanContext().spanId);
  });

  it('marks a failing span as an error and rethrows', async () => {
    exporter.reset();
    await expect(withSpan('boom', {}, () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.events[0]?.name).toBe('exception');
  });
});
