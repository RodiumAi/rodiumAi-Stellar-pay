// Testnet E2E (plan S8): payment via the checkout flow, underpayment + top-up, expiry.
// Starts the compiled API and worker with .env, a local webhook receiver that verifies
// signatures, and a fresh payer that buys testnet USDC on the DEX. Prints a summary.
//   pnpm build:all && pnpm e2e:testnet
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { signRequest } from '@rp/security/hmac-auth';
import { verifyWebhook } from '@rp/security/webhook-signature';
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

process.chdir(new URL('../../../', import.meta.url).pathname);
process.loadEnvFile('.env');
const env = process.env;
const HORIZON = 'https://horizon-testnet.stellar.org';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const API = `http://localhost:${env.PORT ?? '8080'}`;
const horizon = new Horizon.Server(HORIZON);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── webhook receiver ────────────────────────────────────────────────────────
const publicKey = createPublicKey(
  createPrivateKey(env.WEBHOOK_SIGNING_KEY_PEM.replaceAll('\\n', '\n')),
);
const hooks = [];
const receiverPort = Number(new URL(env.WEBHOOK_URL).port || 80);
const receiver = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const v = verifyWebhook(
      (k) => (k === env.WEBHOOK_SIGNING_KEY_ID ? publicKey : undefined),
      String(req.headers['rp-signature']),
      body,
      Math.floor(Date.now() / 1000),
    );
    const json = JSON.parse(body.toString());
    if (!hooks.some((h) => h.id === json.id)) hooks.push({ ...json, verified: v.ok });
    log(
      `webhook ${json.type} for ${json.data.payment_id ?? json.data.subscription_id} signature=${v.ok ? 'valid' : 'INVALID'}`,
    );
    res.writeHead(200).end();
  });
}).listen(receiverPort, '127.0.0.1');

// ── services ────────────────────────────────────────────────────────────────
const children = [];
function start(name, file, extraEnv) {
  const child = spawn(process.execPath, ['--env-file=.env', file], {
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
}
start('api', 'apps/api/dist/main.js', { PAYMENT_TTL_SECONDS: '60' });
start('worker', 'apps/worker/dist/main.js', {});
const stopAll = () => {
  for (const c of children) c.kill('SIGTERM');
  receiver.close();
};
process.on('exit', stopAll);

async function waitFor(predicate, what, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await predicate();
    if (found) return found;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function api(method, path, body) {
  const [keyId, secret] = env.API_HMAC_KEYS.split(',')[0].split(':');
  const raw = Buffer.from(body === undefined ? '' : JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'x-rp-key-id': keyId,
      'x-rp-timestamp': timestamp,
      'x-rp-nonce': nonce,
      'x-rp-signature': signRequest(Buffer.from(secret, 'base64url'), {
        method,
        pathWithQuery: path,
        timestamp,
        nonce,
        body: raw,
      }),
      ...(method === 'POST'
        ? {
            'content-type': 'application/json',
            'idempotency-key': `e2e_${randomBytes(8).toString('hex')}`,
          }
        : {}),
    },
    ...(method === 'POST' ? { body: raw } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const createPayment = (usdMinor, label) =>
  api('POST', '/v1/payments', {
    merchant_order_id: `e2e_${label}_${randomBytes(3).toString('hex')}`,
    customer_ref: 'usr_e2e',
    description: `Testnet E2E — ${label}`,
    amount: { currency: 'USD', value_minor: usdMinor },
    return_url: `${env.RETURN_URL_ORIGINS.split(',')[0]}/billing/return`,
  });

async function memoOf(paymentId) {
  // The memo is not in the API response by design; read it from the checkout page data.
  const p = await api('GET', `/v1/payments/${paymentId}`);
  return p;
}

async function submit(kp, op, memo) {
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
    ...(memo ? { memo } : {}),
  })
    .addOperation(op)
    .setTimeout(120)
    .build();
  tx.sign(kp);
  return (await horizon.submitTransaction(tx)).hash;
}

const hookFor = (paymentId, type) => () =>
  hooks.find((h) => h.type === type && h.data.payment_id === paymentId);
const results = [];

try {
  await waitFor(
    async () => (await fetch(`${API}/v1/health/ready`).catch(() => null))?.ok,
    'API ready',
    60_000,
  );
  log('API ready; funding payer and buying testnet USDC on the DEX');
  const payer = Keypair.random();
  await fetch(`https://friendbot.stellar.org/?addr=${payer.publicKey()}`);
  await submit(payer, Operation.changeTrust({ asset: USDC }));
  await submit(
    payer,
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: '200',
      destination: payer.publicKey(),
      destAsset: USDC,
      destAmount: '20',
      path: [],
    }),
  );
  log(`payer ${payer.publicKey()} holds 20 USDC`);

  // A) Full payment through the checkout flow (prepare → sign → submit).
  const a = await createPayment(500, 'checkout');
  const token = a.checkout_url.split('/c/')[1];
  const page = await fetch(`${API}/c/${token}`);
  log(
    `checkout page ${page.status}, CSP ${page.headers.get('content-security-policy') ? 'present' : 'MISSING'}`,
  );
  const prepared = await (
    await fetch(`${API}/c/${token}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: payer.publicKey() }),
    })
  ).json();
  const tx = TransactionBuilder.fromXdr(prepared.xdr, Networks.TESTNET);
  tx.sign(payer);
  const submitted = await fetch(`${API}/c/${token}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ xdr: tx.toXdr() }),
  });
  log(`checkout submit ${submitted.status} ${JSON.stringify(await submitted.json())}`);
  const aHook = await waitFor(hookFor(a.id, 'payment.confirmed'), 'A confirmed');
  results.push(['A checkout payment → confirmed', aHook.verified]);

  // B) Underpayment via a direct wallet payment (like scanning the QR), then top-up.
  const b = await createPayment(300, 'underpay');
  const bPage = await (await fetch(`${API}${new URL(b.checkout_url).pathname}`)).text();
  const memo = /RP[0-9A-HJKMNP-TV-Z]{12}/.exec(bPage)[0];
  await submit(
    payer,
    Operation.payment({ destination: env.MERCHANT_ADDRESS, asset: USDC, amount: '1' }),
    Memo.text(memo),
  );
  const bUnder = await waitFor(hookFor(b.id, 'payment.underpaid'), 'B underpaid');
  await submit(
    payer,
    Operation.payment({ destination: env.MERCHANT_ADDRESS, asset: USDC, amount: '2' }),
    Memo.text(memo),
  );
  const bDone = await waitFor(hookFor(b.id, 'payment.confirmed'), 'B confirmed');
  results.push([
    'B underpaid → top-up → confirmed (2 tx hashes)',
    bUnder.verified && bDone.verified && bDone.data.tx_hashes.length === 2,
  ]);

  // C) Expiry: nobody pays; the 60 s quote expires.
  const c = await createPayment(100, 'expiry');
  const cHook = await waitFor(hookFor(c.id, 'payment.expired'), 'C expired', 240_000);
  results.push(['C unpaid → expired', cHook.verified && (await memoOf(c.id)).status === 'expired']);
} catch (error) {
  results.push([`FAILED: ${error.message}`, false]);
} finally {
  console.log('\nTestnet E2E summary');
  for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  stopAll();
  process.exit(results.every(([, ok]) => ok) && results.length === 3 ? 0 : 1);
}
