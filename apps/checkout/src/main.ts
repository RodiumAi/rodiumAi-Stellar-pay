import { readCheckoutData, type StatusResponse } from './checkout-data.js';
import './styles.css';
import { setBusy, setText, statusText } from './ui.js';

const data = readCheckoutData(document);
let etag: string | null = null;
let delayMs = 3000;

/** Polls with ETag and backs off 3 s → 15 s (§11.1); redirects on a final state. */
async function poll(): Promise<void> {
  try {
    const res = await fetch(data.statusUrl, {
      headers: etag === null ? {} : { 'if-none-match': etag },
      cache: 'no-store',
    });
    if (res.status === 200) {
      etag = res.headers.get('etag');
      const s = (await res.json()) as StatusResponse;
      setText(document, 'status', statusText(s.status));
      setText(document, 'received', s.amount_received);
      if (s.final) {
        if (s.return_url !== null) window.location.assign(s.return_url);
        return;
      }
    }
  } catch {
    // Network blips: keep polling with backoff.
  }
  delayMs = Math.min(15_000, Math.round(delayMs * 1.5));
  setTimeout(() => void poll(), delayMs);
}

document.getElementById('pay-freighter')?.addEventListener('click', () => {
  setBusy(document, true);
  setText(document, 'wallet-message', 'Opening Freighter…');
  // Wallet code loads only on interaction (§11.4: initial JS budget).
  void import('./wallet.js')
    .then(({ payWithFreighter }) => payWithFreighter(data))
    .then((message) => {
      setText(document, 'wallet-message', message);
      delayMs = 3000;
    })
    .catch((error: unknown) => {
      setText(
        document,
        'wallet-message',
        error instanceof Error ? error.message : 'Payment failed',
      );
    })
    .finally(() => {
      setBusy(document, false);
    });
});

setTimeout(() => void poll(), delayMs);
