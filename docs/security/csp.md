# Checkout CSP exceptions (context §11.3)

**There are none.** The checkout ships the §11.3 policy unchanged:

- one `type="module"` script with a per-request nonce (`'strict-dynamic'` lets it load the lazy Freighter chunk);
- styles only from `/c/assets/*.css` (`style-src 'self'`) — no inline `style` attributes anywhere (tested);
- the QR code is inline SVG using `fill` attributes only (uqr), allowed by `default-src 'none'` because it is markup, not a resource;
- no `innerHTML`/sinks in our code, so `require-trusted-types-for 'script'` needs no policy;
- `connect-src 'self'`: the browser talks only to our server (`/c/{token}/prepare|submit|status`); Freighter runs in its extension context.

This is why Stellar Wallets Kit was not adopted (runtime CSS injection via twind would need a `style-src` relaxation). Any future exception must be the narrowest possible, documented here with the reason, and never `'unsafe-inline'`/`'unsafe-eval'` in `script-src`.
