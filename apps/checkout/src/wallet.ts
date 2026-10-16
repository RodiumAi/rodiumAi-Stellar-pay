import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import type { CheckoutData } from './checkout-data.js';

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = json['error'] as { message?: string } | undefined;
    throw new Error(error?.message ?? 'Request failed');
  }
  return json;
}

/**
 * Freighter flow (§11.1): connect → server builds the exact payment → user signs →
 * server validates (§13.3) and submits. The browser never talks to Stellar directly.
 */
export async function payWithFreighter(data: CheckoutData): Promise<string> {
  if (!(await isConnected()).isConnected) {
    throw new Error('Freighter is not installed. Scan the QR code with a mobile wallet instead.');
  }
  const access = await requestAccess();
  if (access.error !== undefined) throw new Error('Freighter access was declined');
  const network = await getNetworkDetails();
  if (network.networkPassphrase !== data.networkPassphrase) {
    throw new Error('Switch Freighter to the network shown on this page and try again');
  }
  const { address } = await getAddress();
  const prepared = await postJson(data.prepareUrl, { address });
  const signed = await signTransaction(String(prepared['xdr']), {
    networkPassphrase: data.networkPassphrase,
    address,
  });
  if (signed.error !== undefined) throw new Error('Signing was cancelled');
  await postJson(data.submitUrl, { xdr: signed.signedTxXdr });
  return 'Payment sent — waiting for confirmation';
}
