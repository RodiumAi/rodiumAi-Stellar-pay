import { readCheckoutData, type StatusResponse } from './checkout-data.js';
import './styles.css';
import { setBusy, setStatus, setText } from './ui.js';

const data = readCheckoutData(document);
const root = document.documentElement;
const THEME_KEY = 'stelpay-theme'; // shared with the docs on the same origin

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
} catch {
  // Storage blocked: follow the system setting.
}
document.getElementById('theme')?.addEventListener('click', () => {
  const current =
    root.getAttribute('data-theme') ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
});

// Copy buttons for the destination, memo and contract id.
document.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((button) => {
  button.addEventListener('click', () => {
    const value = document.getElementById(button.dataset['copy'] ?? '')?.textContent ?? '';
    void navigator.clipboard.writeText(value).then(() => {
      button.textContent = 'Copied';
      button.classList.add('done');
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('done');
      }, 1600);
    });
  });
});
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
      setStatus(document, s.status);
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
  setText(document, 'wallet-message', 'Opening wallet…');
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
