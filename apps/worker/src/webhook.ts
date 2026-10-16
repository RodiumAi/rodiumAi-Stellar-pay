import type { KeyObject } from 'node:crypto';
import type { OutboxRow } from '@rp/db/schema';
import { signWebhook } from '@rp/security/webhook-signature';

/** Context §10.1: a 2xx within 10 s is delivered; anything else schedules a retry. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookSigner {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

/** The exact bytes sent (and signed): `{ id, type, created_at, data }` (context §10.2). */
export function webhookBody(event: OutboxRow): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: event.id,
      type: event.event_type,
      created_at: event.created_at.toISOString(),
      data: event.payload,
    }),
    'utf8',
  );
}

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function deliverWebhook(
  url: string,
  event: OutboxRow,
  signer: WebhookSigner,
  nowSeconds: number,
  fetchImpl: typeof fetch,
): Promise<DeliveryResult> {
  const body = webhookBody(event);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'rp-signature': signWebhook(signer.privateKey, signer.keyId, nowSeconds, body),
        'rp-event-id': event.id,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${String(res.status)}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : 'delivery_error' };
  }
}
