import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

const tracer = () => trace.getTracer('rodium-pay');

export interface Tracing {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * OpenTelemetry traces (context §18), exported over OTLP/HTTP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (the exporter reads the standard OTEL_* variables);
 * otherwise every span helper is a no-op. Spans are created by hand at service
 * boundaries — no monkey-patching loaders, which also keeps `node --permission` usable.
 */
export function startTracing(o: {
  readonly service: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tests inject a processor; production uses OTLP with batching. */
  readonly processor?: SpanProcessor;
}): Tracing {
  const endpoint = o.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '';
  if (o.processor === undefined && endpoint.trim() === '') {
    return { enabled: false, shutdown: () => Promise.resolve() };
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': o.service,
      'service.namespace': 'rodium-pay',
      'deployment.environment.name': o.env['NODE_ENV'] ?? 'development',
    }),
    spanProcessors: [o.processor ?? new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return { enabled: true, shutdown: () => provider.shutdown() };
}

/** Runs `fn` inside a span; a thrown error marks the span failed and is rethrown. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes, kind }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e instanceof Error ? e : String(e));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Starts a server span for an inbound request, continuing the caller's `traceparent`. */
export function startServerSpan(
  name: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  attributes: Attributes,
): Span {
  const parent = propagation.extract(context.active(), headers);
  return tracer().startSpan(name, { kind: SpanKind.SERVER, attributes }, parent);
}

/** W3C `traceparent` for the active span (empty when tracing is off). */
export function traceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

export { SpanKind, SpanStatusCode, type Span };
