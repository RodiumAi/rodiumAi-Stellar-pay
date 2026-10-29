import type { NetworkName } from '@rp/config/network';
import { minorUnitExponent, parseCurrency } from '@rp/core/money/fiat';
import { formatAmount, type Stroops } from '@rp/core/money/stroops';
import { html, raw, type Html } from './html.js';
import {
  PAYMENT_STATUSES,
  type Overview,
  type PaymentDetail,
  type PaymentFilter,
  type PaymentRow,
  type ReceiptRow,
  type WebhookRow,
} from './queries.js';
import type { ApiReady, TreasuryBalances } from './status.js';

/** What every page needs to draw the frame. */
export interface PageContext {
  readonly basePath: string;
  readonly network: NetworkName;
  /** The merchant (treasury) account payments go to. */
  readonly treasury: string;
  readonly email: string;
  readonly logoutHref: string | null;
}

type Section = 'overview' | 'payments' | 'receipts' | 'webhooks';

/** `1000000n` → `0.10`: trailing zeros dropped, at least two decimals kept. */
export function usdc(amount: bigint): string {
  const [whole = '0', frac = ''] = formatAmount(amount as Stroops).split('.');
  return `${whole}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** Minor units → `12.50 USD`, using the currency's ISO exponent. */
export function fiat(currency: string, minor: bigint): string {
  const parsed = parseCurrency(currency);
  const exponent = parsed.ok ? minorUnitExponent(parsed.value) : 2;
  if (exponent === 0) return `${minor.toString()} ${currency}`;
  const digits = minor.toString().padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)} ${currency}`;
}

/** `2026-10-28 13:55 UTC` (the dashboard is read across time zones; always UTC). */
export function when(d: Date | null): string {
  if (d === null) return '—';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function short(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function explorer(network: NetworkName): string {
  return `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}`;
}

function badge(status: string): Html {
  return html`<span class="badge s-${status.replace(/[^a-z_]/g, '')}"
    >${status.replace('_', ' ')}</span
  >`;
}

function layout(ctx: PageContext, section: Section, title: string, body: Html): string {
  const b = ctx.basePath;
  const nav = (key: Section, label: string, href: string): Html =>
    html`<a href="${href}" ${raw(key === section ? ' aria-current="page"' : '')}>${label}</a>`;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${title} · StelPay admin</title>
        <link rel="stylesheet" href="${b}/admin.css" />
      </head>
      <body>
        <header class="top">
          <a class="brand" href="${b}">StelPay <span>admin</span></a>
          <span class="net net-${ctx.network}"
            >${ctx.network === 'mainnet' ? 'Mainnet · real money' : 'Testnet'}</span
          >
          <nav>
            ${nav('overview', 'Overview', b)} ${nav('payments', 'Payments', `${b}/payments`)}
            ${nav('receipts', 'Receipts', `${b}/receipts`)}
            ${nav('webhooks', 'Webhooks', `${b}/webhooks`)}
          </nav>
          <span class="who"
            >${ctx.email}${ctx.logoutHref === null ? '' : html` · <a href="${ctx.logoutHref}">Sign out</a>`}</span
          >
        </header>
        <main>
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`.toString();
}

function paymentTable(ctx: PageContext, rows: readonly PaymentRow[]): Html {
  if (rows.length === 0) return html`<p class="empty">No payments.</p>`;
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Created</th>
          <th>Order</th>
          <th>Status</th>
          <th class="num">Price</th>
          <th class="num">Due USDC</th>
          <th class="num">Received</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (p) =>
            html`<tr>
              <td><a href="${ctx.basePath}/payments/${p.id}">${when(p.createdAt)}</a></td>
              <td class="mono">${p.merchantOrderId}</td>
              <td>${badge(p.status)}</td>
              <td class="num">${fiat(p.fiatCurrency, p.fiatAmountMinor)}</td>
              <td class="num">${usdc(p.amountDue)}</td>
              <td class="num">${usdc(p.amountReceived)}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function nextLink(href: string, rows: readonly { id: string }[], pageSize: number): Html {
  const last = rows.at(-1);
  if (rows.length < pageSize || last === undefined) return html``;
  const sep = href.includes('?') ? '&' : '?';
  return html`<p class="pager"><a href="${href}${sep}before=${last.id}">Older →</a></p>`;
}

function stat(label: string, value: string, tone: 'ok' | 'warn' | 'bad' | null = null): Html {
  return html`<div class="stat${tone === null ? '' : ` ${tone}`}">
    <span>${label}</span><strong>${value}</strong>
  </div>`;
}

export function overviewPage(
  ctx: PageContext,
  o: Overview,
  treasury: TreasuryBalances | null,
  api: ApiReady | null,
  now: Date,
): string {
  const workerAlive = o.workerLeaseExpiresAt !== null && o.workerLeaseExpiresAt > now;
  const apiText = api === null ? 'unknown' : api.ready ? 'ready' : 'NOT ready';
  const failing =
    api === null
      ? ''
      : Object.entries(api.checks)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(', ');
  const body = html` <section class="grid">
      ${stat('API', failing === '' ? apiText : `${apiText} (${failing})`, api === null ? 'warn' : api.ready ? 'ok' : 'bad')}
      ${stat('Worker', workerAlive ? 'running' : 'NOT running', workerAlive ? 'ok' : 'bad')}
      ${stat('Treasury USDC', treasury === null ? 'Horizon unreachable' : (treasury.usdc ?? 'no trustline'), treasury?.usdc == null ? 'bad' : null)}
      ${stat('Treasury XLM', treasury === null ? '—' : treasury.xlm)}
    </section>
    <section class="grid">
      ${stat('Paid, 24 h', `${String(o.day.confirmed)} of ${String(o.day.created)} · ${usdc(o.day.confirmedVolume)} USDC`)}
      ${stat('Paid, 7 days', `${String(o.week.confirmed)} of ${String(o.week.created)} · ${usdc(o.week.confirmedVolume)} USDC`)}
      ${stat('Open payments', String(o.openPayments))}
      ${stat('Unmatched receipts', String(o.receiptsUnmatched), o.receiptsUnmatched > 0 ? 'warn' : null)}
      ${stat('Webhooks waiting', String(o.webhooksPending), o.webhooksPending > 0 ? 'warn' : null)}
      ${stat('Webhooks dead', String(o.webhooksDead), o.webhooksDead > 0 ? 'bad' : null)}
    </section>
    <p class="muted">
      Treasury
      <a
        class="mono"
        href="${explorer(ctx.network)}/account/${ctx.treasury}"
        rel="noreferrer noopener"
        target="_blank"
        >${short(ctx.treasury)}</a
      >
      · last ledger with a payment to it:
      ${o.lastIngestedLedger === null ? '—' : String(o.lastIngestedLedger)}
    </p>
    <h2>Latest payments</h2>
    ${paymentTable(ctx, o.recent)}
    <p class="pager"><a href="${ctx.basePath}/payments">All payments →</a></p>`;
  return layout(ctx, 'overview', 'Overview', body);
}

export function paymentsPage(
  ctx: PageContext,
  filter: PaymentFilter,
  rows: readonly PaymentRow[],
  pageSize: number,
): string {
  const base = `${ctx.basePath}/payments`;
  const params = new URLSearchParams();
  if (filter.status !== null) params.set('status', filter.status);
  if (filter.search !== null) params.set('q', filter.search);
  const qs = params.toString();
  const body = html` <form class="filters" method="get" action="${base}">
      <input
        type="search"
        name="q"
        value="${filter.search ?? ''}"
        placeholder="Payment id, order id or memo"
        aria-label="Search"
      />
      <select name="status" aria-label="Status">
        <option value="">All statuses</option>
        ${PAYMENT_STATUSES.map(
          (s) =>
            html`<option value="${s}" ${raw(filter.status === s ? ' selected' : '')}>
              ${s.replace('_', ' ')}
            </option>`,
        )}
      </select>
      <button type="submit">Filter</button>
    </form>
    ${paymentTable(ctx, rows)} ${nextLink(qs === '' ? base : `${base}?${qs}`, rows, pageSize)}`;
  return layout(ctx, 'payments', 'Payments', body);
}

function receiptTable(ctx: PageContext, rows: readonly ReceiptRow[], showPayment: boolean): Html {
  if (rows.length === 0) return html`<p class="empty">None.</p>`;
  const ex = explorer(ctx.network);
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Ledger time</th>
          <th>Transaction</th>
          <th>From</th>
          <th class="num">Amount</th>
          <th>Memo</th>
          ${showPayment ? html`<th>Payment</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) =>
            html`<tr>
              <td>${when(r.closedAt)}</td>
              <td class="mono">
                <a href="${ex}/tx/${r.txHash}" rel="noreferrer noopener" target="_blank"
                  >${short(r.txHash, 8, 6)}</a
                >
              </td>
              <td class="mono">
                <a href="${ex}/account/${r.source}" rel="noreferrer noopener" target="_blank"
                  >${short(r.source)}</a
                >
              </td>
              <td class="num">${usdc(r.amount)} ${r.assetCode}</td>
              <td class="mono">${r.memo ?? '—'}</td>
              ${showPayment ? html`<td>${r.paymentId === null ? badge(r.match) : html`<a href="${ctx.basePath}/payments/${r.paymentId}">open</a>`}</td>` : ''}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function webhookTable(ctx: PageContext, rows: readonly WebhookRow[], showTarget: boolean): Html {
  if (rows.length === 0) return html`<p class="empty">None.</p>`;
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Created</th>
          <th>Event</th>
          <th>Status</th>
          <th class="num">Attempts</th>
          <th>Next try / delivered</th>
          <th>Last error</th>
          ${showTarget ? html`<th>Payment</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (w) =>
            html`<tr>
              <td>${when(w.createdAt)}</td>
              <td class="mono">${w.eventType}</td>
              <td>${badge(w.status)}</td>
              <td class="num">${w.attempts}</td>
              <td>
                ${w.status === 'delivered' ? when(w.deliveredAt) : w.status === 'pending' ? when(w.nextAttemptAt) : '—'}
              </td>
              <td class="err">${w.lastError ?? ''}</td>
              ${showTarget ? html`<td><a href="${ctx.basePath}/payments/${w.aggregateId}">open</a></td>` : ''}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function dl(rows: readonly (readonly [string, Html | string])[]): Html {
  return html`<dl class="facts">
    ${rows.map(
      ([k, v]) =>
        html`<dt>${k}</dt>
          <dd>${v}</dd>`,
    )}
  </dl>`;
}

export function paymentPage(ctx: PageContext, p: PaymentDetail): string {
  const ex = explorer(ctx.network);
  const body = html` ${dl([
      ['Status', badge(p.status)],
      ['Payment id', html`<span class="mono">${p.id}</span>`],
      ['Order id', html`<span class="mono">${p.merchantOrderId}</span>`],
      ['Description', p.description],
      ['Price', fiat(p.fiatCurrency, p.fiatAmountMinor)],
      ['Rate', `1 ${p.fiatCurrency} = ${p.fxRate.replace(/\.?0+$/, '')} USD`],
      ['Due', `${usdc(p.amountDue)} USDC`],
      ['Received', `${usdc(p.amountReceived)} USDC`],
      ['Memo', html`<span class="mono">${p.memo}</span>`],
      [
        'Paid to',
        html`<a
          class="mono"
          href="${ex}/account/${p.destination}"
          rel="noreferrer noopener"
          target="_blank"
          >${p.destination}</a
        >`,
      ],
      ['Created', when(p.createdAt)],
      ['Expires', when(p.expiresAt)],
      ['Confirmed', when(p.confirmedAt)],
      ['Last change', when(p.updatedAt)],
      ['Return URL', html`<span class="mono">${p.returnUrl}</span>`],
    ])}
    <h2>On-chain receipts</h2>
    ${receiptTable(ctx, p.receipts, false)}
    <h2>Webhooks</h2>
    ${webhookTable(ctx, p.webhooks, false)}
    ${
      p.audit.length === 0
        ? ''
        : html`<h2>Audit log</h2>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${p.audit.map(
                    (a) =>
                      html`<tr>
                        <td>${when(a.createdAt)}</td>
                        <td>${a.actor}</td>
                        <td class="mono">${a.action}</td>
                        <td class="mono err">${JSON.stringify(a.details)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
    }`;
  return layout(ctx, 'payments', `Payment ${short(p.merchantOrderId, 24, 0)}`, body);
}

export function receiptsPage(
  ctx: PageContext,
  match: 'unmatched' | 'ignored' | 'matched',
  rows: readonly ReceiptRow[],
  pageSize: number,
): string {
  const base = `${ctx.basePath}/receipts`;
  const tabs = (['unmatched', 'ignored', 'matched'] as const).map(
    (m) =>
      html`<a href="${base}?match=${m}" ${raw(m === match ? ' aria-current="page"' : '')}>${m}</a>`,
  );
  const help =
    match === 'unmatched'
      ? html`<p class="muted">
          Money that reached the treasury but matches no payment (wrong memo, wrong asset, late, or
          a blocked sender). Follow the unmatched-payment runbook; refunds are made from the
          treasury wallet.
        </p>`
      : match === 'ignored'
        ? html`<p class="muted">
            Deliberately ignored, e.g. tiny XLM "dust" sent by address-poisoning scams. Never copy
            an address from these.
          </p>`
        : html``;
  const body = html`<nav class="tabs">${tabs}</nav>
    ${help} ${receiptTable(ctx, rows, true)} ${nextLink(`${base}?match=${match}`, rows, pageSize)}`;
  return layout(ctx, 'receipts', 'Receipts', body);
}

export function webhooksPage(
  ctx: PageContext,
  status: 'pending' | 'dead' | 'delivered',
  rows: readonly WebhookRow[],
  pageSize: number,
): string {
  const base = `${ctx.basePath}/webhooks`;
  const tabs = (['pending', 'dead', 'delivered'] as const).map(
    (s) =>
      html`<a href="${base}?status=${s}" ${raw(s === status ? ' aria-current="page"' : '')}
        >${s === 'pending' ? 'waiting' : s}</a
      >`,
  );
  const body = html`<nav class="tabs">${tabs}</nav>
    ${webhookTable(ctx, rows, true)} ${nextLink(`${base}?status=${status}`, rows, pageSize)}`;
  return layout(ctx, 'webhooks', 'Webhooks', body);
}

export function errorPage(ctx: PageContext | null, status: number, message: string): string {
  const body = html`<p>${message}</p>`;
  if (ctx === null)
    return html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>${String(status)}</title>
        </head>
        <body>
          <h1>${String(status)}</h1>
          ${body}
        </body>
      </html>`.toString();
  return layout(ctx, 'overview', String(status), body);
}
