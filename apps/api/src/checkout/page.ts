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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `3.2500000` → `3.25`: trailing zeros dropped, at least two decimals kept (same value). */
export function displayAmount(amount: string): string {
  const [whole, frac = ''] = amount.split('.');
  return `${whole ?? amount}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** ISO instant → `17 Oct 2026, 06:30 UTC`. */
export function displayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}, ${hh}:${mm} UTC`;
}

const MOON =
  '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';

/** Top bar shared by both checkout pages, in the StelPay docs design (RodiumAi brand). */
export function checkoutHeader(networkName: string): string {
  const testnet = networkName !== 'Stellar';
  return `<header class="topbar">
<span class="brand"><span class="logo" role="img" aria-label="RodiumAi"></span><span class="divider"></span><span class="product">StelPay</span></span>
${testnet ? `<span class="tag testnet">${escapeHtml(networkName.replace(/^Stellar /, '').replace(/^\w/, (c) => c.toUpperCase()))}</span>` : ''}
<button class="icon-btn" id="theme" type="button" aria-label="Toggle dark mode">${MOON}</button>
</header>`;
}

export function checkoutFooter(): string {
  return `<footer class="foot"><span class="by">A product of <span class="logo small" role="img" aria-label="RodiumAi"></span></span><span>Non-custodial · settles on Stellar</span></footer>`;
}

/**
 * A detail row. Codes (addresses, memo, amounts) are monospace; `copyId` adds a copy button
 * for values the user may paste into a wallet.
 */
export function fact(label: string, value: string, copyId?: string, mono = true): string {
  const v =
    copyId === undefined
      ? mono
        ? `<code>${escapeHtml(value)}</code>`
        : `<span>${escapeHtml(value)}</span>`
      : `<code id="${copyId}">${escapeHtml(value)}</code><button class="copy" type="button" data-copy="${copyId}" aria-label="Copy ${escapeHtml(label.toLowerCase())}">Copy</button>`;
  return `<div><dt>${escapeHtml(label)}</dt><dd>${v}</dd></div>`;
}

export function pageHead(title: string, assets: PageAssets): string {
  const styles = assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${styles}
</head>`;
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
  const amount = displayAmount(m.amount);
  return `${pageHead(`Pay ${amount} ${m.asset} · StelPay by RodiumAi`, m.assets)}
<body>
${checkoutHeader(m.networkName)}
<main>
<section class="checkout payment" aria-labelledby="title">
<div class="pane details">
<span class="tag">Payment</span>
<h1 id="title">${escapeHtml(m.description)}</h1>
<p class="amount" aria-label="Amount due">${escapeHtml(amount)} <span>${escapeHtml(m.asset)}</span></p>
<p class="status-pill"><span class="status-dot" id="status-dot" data-status="pending"></span><span id="status" role="status" aria-live="polite">${escapeHtml(m.statusText)}</span></p>
<dl class="facts">
${fact('Network', m.networkName, undefined, false)}
${fact('Exact amount', `${m.amount} ${m.asset}`)}
${fact('Send to', m.destination, 'destination')}
${fact('Memo (required)', m.memo, 'memo')}
<div><dt>Received</dt><dd><code id="received">0.0000000</code></dd></div>
${fact('Asset issuer', m.assetIssuer)}
<div><dt>Expires</dt><dd><time datetime="${escapeHtml(m.expiresAt)}">${escapeHtml(displayTime(m.expiresAt))}</time></dd></div>
</dl>
</div>
<div class="pane pay">
<span id="qr-title" class="visually-hidden">QR code for a Stellar payment request</span>
<div class="qr-box">${qr}</div>
<p class="hint center">Scan with a mobile wallet (LOBSTR, xBull…) or pay from your browser.</p>
<div class="actions">
<button type="button" class="btn primary" id="pay-freighter">Pay with Varial</button>
<a class="btn" href="${escapeHtml(m.payUri)}">Open in a Stellar wallet</a>
</div>
<p class="note">Always include the memo, or the payment cannot be matched.</p>
<p id="wallet-message" class="hint center" role="status" aria-live="polite"></p>
</div>
</section>
${checkoutFooter()}
</main>
<script type="application/json" id="rp-checkout">${jsonForScript(m.data)}</script>
<script type="module" nonce="${escapeHtml(m.nonce)}" src="${escapeHtml(m.assets.script)}"></script>
</body>
</html>`;
}
