import { renderSVG } from 'uqr';

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES.get(c) ?? c);
}

/** JSON inside <script type="application/json">: neutralise "</script" and comments. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export interface PageAssets {
  readonly script: string;
  readonly styles: readonly string[];
}

export interface PaymentPageModel {
  readonly nonce: string;
  readonly assets: PageAssets;
  readonly description: string;
  readonly amount: string;
  readonly asset: string;
  readonly assetIssuer: string;
  readonly destination: string;
  readonly memo: string;
  readonly payUri: string;
  readonly networkName: string;
  readonly expiresAt: string;
  readonly statusText: string;
  readonly data: unknown;
}

/**
 * Server-rendered checkout (context §11.1): amount, asset, destination and memo in plain
 * text so the user can check them in their wallet; SEP-7 QR as inline SVG; one nonce'd
 * module script; no inline styles or handlers.
 */
export function renderPaymentPage(m: PaymentPageModel): string {
  const qr = renderSVG(m.payUri, { border: 2 }).replace(
    '<svg ',
    '<svg class="qr" role="img" aria-labelledby="qr-title" ',
  );
  const styles = m.assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pay ${escapeHtml(m.amount)} ${escapeHtml(m.asset)} — RodiumAI</title>
${styles}
</head>
<body>
<main>
<section class="card" aria-labelledby="title">
<h1 id="title">${escapeHtml(m.description)}</h1>
<p class="amount" aria-label="Amount due">${escapeHtml(m.amount)} ${escapeHtml(m.asset)}</p>
<dl>
<dt>Network</dt><dd>${escapeHtml(m.networkName)}</dd>
<dt>Asset</dt><dd>${escapeHtml(m.asset)} (issuer ${escapeHtml(m.assetIssuer)})</dd>
<dt>Send to</dt><dd>${escapeHtml(m.destination)}</dd>
<dt>Memo (required)</dt><dd>${escapeHtml(m.memo)}</dd>
<dt>Received</dt><dd id="received">0.0000000</dd>
<dt>Expires</dt><dd><time datetime="${escapeHtml(m.expiresAt)}">${escapeHtml(m.expiresAt)}</time></dd>
</dl>
<span id="qr-title" class="visually-hidden">QR code for a Stellar payment request</span>
${qr}
<div class="actions">
<button type="button" id="pay-freighter">Pay with Freighter</button>
<a class="button" href="${escapeHtml(m.payUri)}">Open in a Stellar wallet</a>
</div>
<p class="hint">Mobile wallets: scan the QR code. Always include the memo, or the payment cannot be matched.</p>
<p id="wallet-message" class="hint" role="status" aria-live="polite"></p>
<p id="status" class="status" role="status" aria-live="polite">${escapeHtml(m.statusText)}</p>
</section>
</main>
<script type="application/json" id="rp-checkout">${jsonForScript(m.data)}</script>
<script type="module" nonce="${escapeHtml(m.nonce)}" src="${escapeHtml(m.assets.script)}"></script>
</body>
</html>`;
}
