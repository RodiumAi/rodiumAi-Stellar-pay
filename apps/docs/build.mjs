// Builds the StelPay documentation site (served by the API at / and /docs/*) from
// docs/integration.md plus the hand-written landing and quickstart pages in src/.
// Everything is rendered at build time: syntax highlighting, sequence diagrams and the
// search index, so the browser loads only one stylesheet and two small scripts (CSP
// `script-src 'self'`, no inline code).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import http from 'highlight.js/lib/languages/http';
import json from 'highlight.js/lib/languages/json';
import typescript from 'highlight.js/lib/languages/typescript';
import { Marked } from 'marked';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('http', http);
hljs.registerLanguage('json', json);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('typescript', typescript);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'dist');
const REPO = 'https://github.com/RodiumAi/rodiumAi-Stellar-pay';
const BASE_URL = 'https://stelpay.forge.rodiumai.io';
const CONTRACT =
  'https://stellar.expert/explorer/testnet/contract/CCREU5CNPJQGSQ3W4QN4Z7MXYIYHQJVLEALU5LUL7WGNYZSLWXFHGSFK';

/** docs/integration.md section number → page. Order and grouping drive the sidebar. */
const SECTIONS = {
  1: { slug: 'how-it-works', title: 'How it works', group: 'Get started' },
  2: { slug: 'environments', title: 'Environments & credentials', group: 'Get started' },
  3: { slug: 'authentication', title: 'Authentication', group: 'Guides' },
  4: { slug: 'idempotency', title: 'Idempotency', group: 'Guides' },
  6: { slug: 'checkout', title: 'Hosted checkout', group: 'Guides' },
  7: { slug: 'webhooks', title: 'Webhooks', group: 'Guides' },
  8: { slug: 'access-rules', title: 'Granting access', group: 'Guides' },
  9: { slug: 'amounts', title: 'Amounts & currencies', group: 'Guides' },
  5: { slug: 'api-reference', title: 'Endpoints', group: 'API reference' },
  10: { slug: 'errors', title: 'Errors & rate limits', group: 'API reference' },
  11: { slug: 'testing', title: 'Testing on testnet', group: 'Launch' },
  12: { slug: 'go-live', title: 'Go-live checklist', group: 'Launch' },
  13: { slug: 'limitations', title: 'Known limitations', group: 'Launch' },
};
const GROUPS = ['Get started', 'Guides', 'API reference', 'Launch'];

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[`'"()/{}.,:§—–]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 64);
const stripNumber = (t) => t.replace(/^\d+(\.\d+)*\.?\s+/, '');

// ── split docs/integration.md into sections ──────────────────────────────────
const source = readFileSync(join(root, 'docs', 'integration.md'), 'utf8');
const sections = new Map();
let current = null;
for (const line of source.split('\n')) {
  const m = /^## (\d+)\. (.+)$/.exec(line);
  if (m) {
    current = Number(m[1]);
    sections.set(current, []);
    continue;
  }
  if (/^## /.test(line))
    current = null; // "Contents" and any unnumbered H2
  else if (current !== null) sections.get(current).push(line);
}

// Heading id → page slug, for cross-page anchors (#3-authentication-request-signing).
const anchorPage = new Map();
for (const [n, lines] of sections) {
  const page = SECTIONS[n];
  if (!page) continue;
  for (const line of lines) {
    const h = /^###+ (.+)$/.exec(line);
    if (h) anchorPage.set(slugify(stripNumber(h[1])), page.slug);
  }
}

// ── sequence diagrams (mermaid sequenceDiagram → styled steps, no runtime) ───
function sequence(code) {
  const actors = new Map();
  const root = { items: [] };
  const stack = [root];
  const actor = (id) => {
    if (!actors.has(id)) actors.set(id, { id, label: id });
    return actors.get(id);
  };
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    let m;
    if (!line || line === 'sequenceDiagram' || line === 'autonumber') continue;
    if ((m = /^(actor|participant)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line))) {
      actor(m[2]).label = m[3] ?? m[2];
    } else if ((m = /^(alt|opt|loop|par)\s+(.+)$/.exec(line))) {
      const group = { kind: m[1], branches: [{ label: m[2], items: [] }] };
      stack.at(-1).items.push(group);
      stack.push(group.branches[0]);
      stack[stack.length - 1].group = group;
    } else if ((m = /^else\s*(.*)$/.exec(line))) {
      const branch = stack.pop();
      const group = branch.group;
      const next = { label: m[1] || 'otherwise', items: [], group };
      group.branches.push(next);
      stack.push(next);
    } else if (line === 'end') {
      stack.pop();
    } else if ((m = /^Note\s+(?:over|left of|right of)\s+([^:]+):\s*(.+)$/.exec(line))) {
      stack.at(-1).items.push({ note: m[2], who: m[1].split(',').map((s) => actor(s.trim())) });
    } else if (
      (m =
        /^([A-Za-z0-9_]+)\s*(-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(
          line,
        ))
    ) {
      stack.at(-1).items.push({
        from: actor(m[1]),
        to: actor(m[3]),
        reply: m[2].startsWith('--'),
        text: m[4],
      });
    }
  }
  const index = new Map([...actors.keys()].map((id, i) => [id, i % 8]));
  const chip = (a) =>
    `<span class="chip c${index.get(a.id)}" title="${esc(a.label)}">${esc(a.id)}</span>`;
  let n = 0;
  const renderItems = (items) =>
    items
      .map((it) => {
        if (it.branches) {
          return `<li class="seq-group">${it.branches
            .map(
              (b, i) =>
                `<div class="seq-branch"><div class="seq-cond">${i === 0 ? (it.kind === 'loop' ? 'Repeat' : 'If') : 'Else'} · ${esc(b.label)}</div><ol class="seq-steps">${renderItems(b.items)}</ol></div>`,
            )
            .join('')}</li>`;
        }
        if (it.note)
          return `<li class="seq-note">${it.who.map(chip).join('')}<span>${esc(it.note)}</span></li>`;
        n += 1;
        const self = it.from.id === it.to.id;
        return `<li class="seq-step${it.reply ? ' reply' : ''}"><span class="seq-n">${n}</span>${chip(it.from)}${self ? '' : `<span class="arrow" aria-label="${it.reply ? 'replies to' : 'to'}">${it.reply ? '←' : '→'}</span>${chip(it.to)}`}<span class="seq-msg">${esc(it.text)}</span></li>`;
      })
      .join('');
  const legend = [...actors.values()].map((a) => `<li>${chip(a)} ${esc(a.label)}</li>`).join('');
  return `<figure class="seq"><ul class="seq-legend">${legend}</ul><ol class="seq-steps">${renderItems(root.items)}</ol></figure>`;
}

// ── markdown → HTML ──────────────────────────────────────────────────────────
function codeBlock(text, lang) {
  const l = (lang ?? '').trim().toLowerCase();
  const known = l && hljs.getLanguage(l);
  const html = known ? hljs.highlight(text, { language: l }).value : esc(text);
  const label =
    {
      ts: 'TypeScript',
      typescript: 'TypeScript',
      json: 'JSON',
      http: 'HTTP',
      bash: 'Shell',
      sh: 'Shell',
    }[l] ??
    (l || 'Text');
  return `<div class="code"><div class="code-head"><span>${esc(label)}</span><button class="copy" type="button" aria-label="Copy code">Copy</button></div><pre><code class="hljs language-${esc(l || 'text')}">${html}</code></pre></div>`;
}

function rewriteHref(href) {
  if (/^(https?:|mailto:)/.test(href)) return href;
  if (href.startsWith('#')) {
    const id = href.slice(1);
    const key = [...anchorPage.keys()].find(
      (k) => id.endsWith(k) || k === slugify(id.replace(/^\d+(-\d+)*-/, '')),
    );
    return key ? `/docs/${anchorPage.get(key)}#${key}` : href;
  }
  const path = href.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  return `${REPO}/blob/main/${path.startsWith('docs/') || path.includes('/') ? path : `docs/${path}`}`;
}

/** "§8.2" → link to that page (references to docs/context.md are left alone). */
function sectionLinks(html) {
  return html.replace(
    /(context(?:\.md)?<\/code>|context(?:\.md)?)?(\s*)§(\d+)(?:\.(\d+))?/g,
    (all, ctx, sp, a) => {
      if (ctx) return all;
      const page = SECTIONS[Number(a)];
      return page ? `${sp}<a href="/docs/${page.slug}">${esc(page.title)}</a>` : all;
    },
  );
}

function renderMarkdown(md, toc) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const level = Math.min(depth - 1, 4); // ### → h2 (page title is h1)
        const plain = stripNumber(text);
        const id = slugify(plain);
        const ep = /^`(GET|POST|PUT|PATCH|DELETE)\s+([^`]+)`\s*(?:—|-)?\s*(.*)$/.exec(plain);
        let inner;
        let label;
        if (ep) {
          inner = `<span class="method ${ep[1].toLowerCase()}">${ep[1]}</span><code class="path">${esc(ep[2])}</code>${ep[3] ? `<span class="h-desc">${esc(ep[3])}</span>` : ''}`;
          label = `${ep[1]} ${ep[2]}`;
        } else {
          inner = this.parser.parseInline(tokens).replace(/^\d+(\.\d+)*\.?\s+/, '');
          label = plain.replace(/`/g, '');
        }
        if (level === 2) toc.push({ id, label, method: ep?.[1] });
        return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${level}>\n`;
      },
      code({ text, lang }) {
        if ((lang ?? '').trim() === 'mermaid') return sequence(text);
        return codeBlock(text, lang);
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        const kind = /<strong>([^<]+)<\/strong>/.exec(body)?.[1]?.toLowerCase() ?? '';
        const type = /warn|never|danger|important/.test(kind)
          ? 'warning'
          : /tip/.test(kind)
            ? 'tip'
            : 'note';
        return `<div class="callout ${type}">${body}</div>\n`;
      },
      table(token) {
        const head = token.header
          .map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`)
          .join('');
        const rows = token.rows
          .map(
            (r) =>
              `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`,
          )
          .join('');
        return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
      link({ href, title, tokens }) {
        const url = rewriteHref(href);
        const ext = /^https?:/.test(url) && !url.startsWith(BASE_URL);
        return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener" target="_blank"' : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  return sectionLinks(marked.parse(md));
}

// ── hand-written pages ───────────────────────────────────────────────────────
const tabs = (id, panes) =>
  `<div class="tabs" data-tabs="${id}"><div class="tablist" role="tablist">${panes
    .map(
      (p, i) =>
        `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${i}">${esc(p.label)}</button>`,
    )
    .join('')}</div>${panes
    .map(
      (p, i) =>
        `<div class="tabpanel" role="tabpanel"${i === 0 ? '' : ' hidden'} data-panel="${i}">${codeBlock(p.code, p.lang)}</div>`,
    )
    .join('')}</div>`;

const quickstart = `
<p class="lead">Take a payment from your backend in four steps. You need the API key and the webhook public key from the StelPay team (see <a href="/docs/environments">Environments &amp; credentials</a>).</p>
<ol class="steps">
<li><h2 id="sign-requests">Sign your requests</h2>
<p>Every <code>/v1</code> call is signed with HMAC-SHA256 over the method, path, timestamp, a one-time nonce and the SHA-256 of the body. No SDK needed — only <code>node:crypto</code>.</p>
${codeBlock(
  `import { createHash, createHmac, randomBytes } from 'node:crypto';

export function signedHeaders(
  keyId: string,
  secret: Buffer,
  method: string,
  path: string,
  body = '',
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\\n');
  const signature = createHmac('sha256', secret).update(canonical).digest('base64url');
  return {
    'X-RP-Key-Id': keyId,
    'X-RP-Timestamp': timestamp,
    'X-RP-Nonce': nonce,
    'X-RP-Signature': signature,
  };
}`,
  'ts',
)}
<div class="callout note"><p><strong>Full client.</strong> The complete NestJS client with retries and typed responses is in <a href="/docs/authentication">Authentication</a>.</p></div></li>
<li><h2 id="create-a-payment">Create a payment</h2>
<p>Amounts are in the fiat currency's minor units. StelPay converts to USDC at the live rate and returns a hosted checkout link.</p>
${tabs('create', [
  {
    label: 'TypeScript',
    lang: 'ts',
    code: `const body = JSON.stringify({
  merchant_order_id: 'ord_8f2c',
  customer_ref: 'usr_19ab',
  description: 'RodiumAI Pro — 1 month',
  amount: { currency: 'GHS', value_minor: 5000 }, // GHS 50.00
  return_url: 'https://app.rodiumai.io/billing/return?order=ord_8f2c',
});
const res = await fetch('${BASE_URL}/v1/payments', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'pay_ord_8f2c_1',
    ...signedHeaders(KEY_ID, SECRET, 'POST', '/v1/payments', body),
  },
  body,
});
const payment = await res.json(); // { id, status: "pending", checkout_url, amount_due, ... }`,
  },
  {
    label: 'Response',
    lang: 'json',
    code: `{
  "id": "0192a0b4-7c1e-7d3a-9f2b-3c4d5e6f7a8b",
  "status": "pending",
  "merchant_order_id": "ord_8f2c",
  "amount_due": { "asset": "USDC", "value": "3.2500000" },
  "expires_at": "2026-10-16T12:20:00.000Z",
  "checkout_url": "${BASE_URL}/c/Vq1oZ3Jm2c8yYk3G9wQ0l2a4tF6bN8xR1pS5uW7eH0c"
}`,
  },
])}</li>
<li><h2 id="redirect-to-checkout">Send the user to checkout</h2>
<p>Redirect the browser to <code>checkout_url</code>. The user pays from Freighter or scans a QR code with any Stellar mobile wallet. When the payment is final they return to your <code>return_url</code>.</p>
<div class="callout warning"><p><strong>Never grant access on the redirect.</strong> The return trip only means the user left the checkout page — wait for the signed webhook (or poll the payment) before unlocking anything.</p></div></li>
<li><h2 id="handle-the-webhook">Handle the webhook</h2>
<p>StelPay sends <code>payment.confirmed</code> to your webhook URL, signed with Ed25519 over the raw body. Verify, de-duplicate on the event <code>id</code>, then grant access.</p>
${codeBlock(
  `import { createPublicKey, verify } from 'node:crypto';

// rp-signature: t=<unix seconds>,k=<key id>,s=<base64url signature>
export function verifyWebhook(rawBody: Buffer, header: string, publicKeyPem: string): boolean {
  const m = /^t=(\\d+),k=([\\w-]+),s=([\\w-]{86})$/.exec(header);
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const signed = Buffer.concat([Buffer.from(m[1] + '.'), rawBody]);
  return verify(null, signed, createPublicKey(publicKeyPem), Buffer.from(m[3], 'base64url'));
}`,
  'ts',
)}
<div class="callout tip"><p><strong>Exact format.</strong> The precise signed payload, a test vector and the full NestJS receiver are in <a href="/docs/webhooks">Webhooks</a> — copy those rather than this sketch.</p></div></li>
</ol>
<div class="next-cards">
<a class="card" href="/docs/how-it-works"><strong>How it works</strong><span>Sequence of a payment and a subscription</span></a>
<a class="card" href="/docs/api-reference"><strong>Endpoints</strong><span>Every route, field and error</span></a>
<a class="card" href="/docs/testing"><strong>Test on testnet</strong><span>Wallet setup and scenarios</span></a>
</div>`;

const landing = `
<section class="hero">
<p class="eyebrow"><span class="status-dot" data-status></span><span data-status-text>Checking service…</span> · Stellar testnet</p>
<h1>Accept USDC on Stellar,<br>as easily as mobile money.</h1>
<p class="lead">StelPay is a payment API for one-time payments and recurring subscriptions in USDC. Your app calls a signed REST API and gets a hosted checkout link and signed webhooks — no wallets, keys or blockchain code in your codebase.</p>
<div class="hero-actions"><a class="btn primary" href="/docs/quickstart">Quickstart</a><a class="btn" href="/docs/api-reference">API reference</a><a class="btn ghost" href="${REPO}" rel="noopener" target="_blank">GitHub ↗</a></div>
<div class="hero-code">${codeBlock(
  `POST ${BASE_URL}/v1/payments
Idempotency-Key: pay_ord_8f2c_1
X-RP-Key-Id: ak_2026_10   X-RP-Signature: …

{ "amount": { "currency": "GHS", "value_minor": 5000 }, "merchant_order_id": "ord_8f2c", … }

→ 201 { "status": "pending", "amount_due": { "asset": "USDC", "value": "3.2500000" },
        "checkout_url": "${BASE_URL}/c/…" }`,
  'http',
)}</div>
</section>
<section class="features">
<div class="feature"><span class="icon" aria-hidden="true">⚡</span><h2>One-time payments</h2><p>Fiat prices converted to USDC at the live rate. Settles in ~5 seconds, worldwide, for a fraction of a cent. Underpayments and top-ups handled.</p></div>
<div class="feature"><span class="icon" aria-hidden="true">↻</span><h2>Subscriptions on-chain</h2><p>Users sign once. A Soroban smart contract enforces the price, the schedule and the recipient — it can never charge early, twice or more.</p></div>
<div class="feature"><span class="icon" aria-hidden="true">✓</span><h2>Signed webhooks</h2><p><code>payment.confirmed</code>, <code>subscription.renewed</code> and more, Ed25519-signed and delivered at least once with retries.</p></div>
<div class="feature"><span class="icon" aria-hidden="true">🔒</span><h2>Non-custodial</h2><p>Money moves straight from the user's wallet to your merchant account. StelPay never holds funds.</p></div>
</section>
<section class="flow">
<h2>Integrate in an afternoon</h2>
<ol class="flow-steps">
<li><strong>Create</strong><span>Your backend calls <code>POST /v1/payments</code> with a signed request.</span></li>
<li><strong>Redirect</strong><span>Send the user to the hosted <code>checkout_url</code>.</span></li>
<li><strong>Pay</strong><span>They pay from Freighter or any SEP-7 mobile wallet.</span></li>
<li><strong>Confirm</strong><span>You receive <code>payment.confirmed</code> and grant access.</span></li>
</ol>
</section>
<section class="links">
<a class="card" href="/docs/quickstart"><strong>Quickstart</strong><span>First payment in four steps</span></a>
<a class="card" href="/docs/webhooks"><strong>Webhooks</strong><span>Verify signatures, every event type</span></a>
<a class="card" href="${CONTRACT}" rel="noopener" target="_blank"><strong>Subscription contract ↗</strong><span>Live on Stellar testnet</span></a>
</section>`;

// ── assemble pages ───────────────────────────────────────────────────────────
const pages = [
  { slug: '', title: 'StelPay', group: null, html: landing, toc: [], landing: true },
  { slug: 'quickstart', title: 'Quickstart', group: 'Get started', html: quickstart, toc: [] },
];
for (const n of Object.keys(SECTIONS).map(Number)) {
  const meta = SECTIONS[n];
  const lines = sections.get(n);
  if (!lines) throw new Error(`docs/integration.md has no section ${n}`);
  const toc = [];
  const html = renderMarkdown(lines.join('\n'), toc);
  pages.push({ ...meta, html, toc });
}
for (const id of [
  'sign-requests',
  'create-a-payment',
  'redirect-to-checkout',
  'handle-the-webhook',
])
  pages[1].toc.push({
    id,
    label: {
      'sign-requests': 'Sign your requests',
      'create-a-payment': 'Create a payment',
      'redirect-to-checkout': 'Send the user to checkout',
      'handle-the-webhook': 'Handle the webhook',
    }[id],
  });

const ordered = [
  pages[1],
  ...GROUPS.flatMap((g) => pages.filter((p) => p.group === g && p.slug !== 'quickstart')),
];
const order = [pages[1], ...ordered.slice(1)];

// ── assets with content hashes (cached immutably by the API) ─────────────────
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
const hashed = (name, content) => {
  const h = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const file = name.replace(/\.(\w+)$/, `.${h}.$1`);
  writeFileSync(join(out, 'assets', file), content);
  return `/docs-assets/${file}`;
};
const css = hashed('docs.css', readFileSync(join(here, 'src', 'docs.css')));
const themeJs = hashed('theme.js', readFileSync(join(here, 'src', 'theme.js')));
const js = hashed('docs.js', readFileSync(join(here, 'src', 'docs.js')));
const logo = hashed('logo.svg', readFileSync(join(here, 'src', 'logo.svg')));

const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const search = order.flatMap((p) => [
  { t: p.title, u: `/docs/${p.slug}`, s: p.group ?? '', x: textOf(p.html).slice(0, 160) },
  ...p.toc.map((h) => ({ t: h.label, u: `/docs/${p.slug}#${h.id}`, s: p.title, x: '' })),
]);
const searchUrl = hashed('search.json', JSON.stringify(search));

const nav = (active) =>
  GROUPS.map((g) => {
    const items = order.filter((p) => p.group === g);
    return `<div class="nav-group"><p class="nav-title">${esc(g)}</p><ul>${items
      .map(
        (p) =>
          `<li><a href="/docs/${p.slug}"${p.slug === active ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`,
      )
      .join('')}</ul></div>`;
  }).join('');

function layout(p) {
  const i = order.indexOf(p);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  const url = p.landing ? '/' : `/docs/${p.slug}`;
  const description = p.landing
    ? 'StelPay: accept USDC on Stellar for one-time payments and subscriptions, with a signed REST API, hosted checkout and webhooks.'
    : `${p.title} — StelPay integration docs.`;
  const toc = p.toc.length
    ? `<aside class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${p.toc
        .map(
          (h) =>
            `<li><a href="#${h.id}">${h.method ? `<span class="method mini ${h.method.toLowerCase()}">${h.method}</span>` : ''}${esc(h.method ? h.label.replace(/^\w+ /, '') : h.label)}</a></li>`,
        )
        .join('')}</ul></aside>`
    : '';
  const article = p.landing
    ? `<main id="content" class="landing">${p.html}</main>`
    : `<main id="content" class="doc"><article><p class="breadcrumb">${esc(p.group)}</p><h1>${esc(p.title)}</h1>${p.html}
<footer class="doc-foot"><div class="pager">${prev ? `<a class="prev" href="/docs/${prev.slug}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="/docs/${next.slug}"><span>Next</span>${esc(next.title)}</a>` : ''}</div>
<p class="edit"><a href="${REPO}/blob/main/${p.slug === 'quickstart' ? 'apps/docs/build.mjs' : 'docs/integration.md'}" rel="noopener" target="_blank">Edit this page on GitHub ↗</a></p></footer></article>${toc}</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.landing ? 'StelPay — USDC payments on Stellar' : `${p.title} · StelPay Docs`)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(p.landing ? 'StelPay' : `${p.title} · StelPay Docs`)}">
<meta property="og:description" content="${esc(description)}">
<link rel="canonical" href="${BASE_URL}${url}">
<link rel="icon" href="${logo}" type="image/svg+xml">
<link rel="stylesheet" href="${css}">
<script src="${themeJs}"></script>
<script src="${js}" defer data-search="${searchUrl}"></script>
</head>
<body${p.landing ? ' class="is-landing"' : ''}>
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
<button class="menu" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">☰</button>
<a class="brand" href="/"><img src="${logo}" alt="" width="26" height="26"><span>StelPay</span><span class="badge">Docs</span></a>
<span class="pill testnet" title="All examples run on the Stellar test network">Testnet</span>
<div class="search"><input type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off" spellcheck="false"><kbd>/</kbd><div class="results" role="listbox" hidden></div></div>
<nav class="top-links" aria-label="Site"><a href="/docs/quickstart">Quickstart</a><a href="/docs/api-reference">API</a><a href="${REPO}" rel="noopener" target="_blank">GitHub</a>
<span class="status" title="Live API status"><span class="status-dot" data-status></span><span class="status-label" data-status-text>Status</span></span>
<button class="theme" type="button" aria-label="Toggle dark mode">◐</button></nav>
</header>
<div class="shell">
<nav id="sidebar" class="sidebar" aria-label="Documentation"><a class="nav-home" href="/"${p.landing ? ' aria-current="page"' : ''}>Overview</a>${nav(p.slug)}</nav>
${article}
</div>
</body>
</html>
`;
}

for (const p of pages) {
  const file = p.landing ? join(out, 'index.html') : join(out, 'docs', `${p.slug}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, layout(p));
}
console.log(`docs built: ${pages.length} pages → apps/docs/dist`);
