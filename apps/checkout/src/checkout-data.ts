/** Server-rendered page data (`<script type="application/json" id="rp-checkout">`). */
export interface CheckoutData {
  readonly kind: 'payment' | 'subscription';
  readonly status: string;
  readonly networkPassphrase: string;
  readonly statusUrl: string;
  readonly prepareUrl: string;
  readonly submitUrl: string;
}

export function readCheckoutData(doc: Document): CheckoutData {
  const el = doc.getElementById('rp-checkout');
  if (el?.textContent == null) throw new Error('checkout data missing');
  return JSON.parse(el.textContent) as CheckoutData;
}

export interface StatusResponse {
  readonly status: string;
  readonly final: boolean;
  readonly amount_due: string;
  readonly amount_received: string;
  readonly return_url: string | null;
}
