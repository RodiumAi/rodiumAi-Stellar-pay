// Testnet E2E for subscriptions (plan S9): create → charge → failed charge → wallet cancel.
// Needs the E2E contract build (plan renews every 120 s) in SUBSCRIPTION_CONTRACT_ID, the
// signer/worker mTLS settings and KEEPER_SECRET in .env (`pnpm build:all` first).
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { signRequest } from '@rp/security/hmac-auth';
import { verifyWebhook } from '@rp/security/webhook-signature';
import {
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

process.chdir(new URL('../../../', import.meta.url).pathname);
process.loadEnvFile('.env');
const env = process.env;
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const API = `http://localhost:${env.PORT ?? '8080'}`;
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const soroban = new rpc.Server('https://soroban-testnet.stellar.org');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const publicKey = createPublicKey(
  createPrivateKey(env.WEBHOOK_SIGNING_KEY_PEM.replaceAll('\\n', '\n')),
);
const hooks = [];
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
    if (json.type.startsWith('subscription.'))
      log(`webhook ${json.type} signature=${v.ok ? 'valid' : 'INVALID'}`);
    res.writeHead(200).end();
  });
}).listen(Number(new URL(env.WEBHOOK_URL).port || 80), '127.0.0.1');

const children = [];
function start(name, args) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n'))
      if (/"level":(40|50)/.test(line)) process.stderr.write(`[${name}] ${line.slice(0, 300)}\n`);
  });
  children.push(child);
}
start('signer', [
  '--permission',
  `--allow-fs-read=${process.cwd()}`,
  '--env-file=.env',
  'apps/signer/dist/main.js',
]);
start('api', ['--env-file=.env', 'apps/api/dist/main.js']);
start('worker', ['--env-file=.env', 'apps/worker/dist/main.js']);
const stopAll = () => {
  for (const c of children) c.kill('SIGTERM');
  receiver.close();
};
process.on('exit', stopAll);

async function waitFor(predicate, what, timeoutMs = 360_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await predicate();
    if (found) return found;
    await sleep(3000);
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

async function classic(kp, op) {
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: '1000', networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(120)
    .build();
  tx.sign(kp);
  return (await horizon.submitTransaction(tx)).hash;
}

const hookFor = (subId, type) => () =>
  hooks.find((h) => h.type === type && h.data.subscription_id === subId);
const results = [];

try {
  await waitFor(
    async () => (await fetch(`${API}/v1/health/ready`).catch(() => null))?.ok,
    'API ready',
    60_000,
  );
  const payer = Keypair.random();
  await fetch(`https://friendbot.stellar.org/?addr=${payer.publicKey()}`);
  await classic(payer, Operation.changeTrust({ asset: USDC }));
  await classic(
    payer,
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: '50',
      destination: payer.publicKey(),
      destAsset: USDC,
      destAmount: '3',
      path: [],
    }),
  );
  log(`payer ${payer.publicKey()} holds 3 USDC`);

  // 1) Create: subscribe through the hosted checkout with one signature.
  const sub = await api('POST', '/v1/subscriptions', {
    merchant_subscription_ref: `e2e_${randomBytes(3).toString('hex')}`,
    customer_ref: 'usr_e2e',
    plan_code: 'pro_monthly',
    return_url: `${env.RETURN_URL_ORIGINS.split(',')[0]}/billing/return`,
  });
  const token = sub.checkout_url.split('/c/')[1];
  const page = await fetch(`${API}/c/${token}`);
  log(`subscription page ${page.status}`);
  const prepared = await (
    await fetch(`${API}/c/${token}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: payer.publicKey() }),
    })
  ).json();
  if (prepared.xdr === undefined) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
  const tx = TransactionBuilder.fromXdr(prepared.xdr, Networks.TESTNET);
  tx.sign(payer);
  const submitted = await (
    await fetch(`${API}/c/${token}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr: tx.toXdr() }),
    })
  ).json();
  log(`subscribe submit → ${JSON.stringify(submitted)}`);
  const activated = await waitFor(hookFor(sub.id, 'subscription.activated'), 'activated', 120_000);
  const contractSubId = BigInt(activated.data.contract_subscription_id);
  results.push(['1 subscribe via checkout → activated (one signature)', activated.verified]);

  // 2) Charge: the worker charges via the signer once the 120 s period ends.
  const renewed = await waitFor(hookFor(sub.id, 'subscription.renewed'), 'renewed');
  results.push(['2 keeper charge via signer → renewed', renewed.verified]);

  // 3) Failed charge: the payer spends their USDC; the next charge's simulation fails.
  const balance = (await horizon.loadAccount(payer.publicKey())).balances.find(
    (b) => b.asset_code === 'USDC',
  ).balance;
  await classic(
    payer,
    Operation.pathPaymentStrictSend({
      sendAsset: USDC,
      sendAmount: balance,
      destination: payer.publicKey(),
      destAsset: Asset.native(),
      destMin: '0.0000001',
      path: [],
    }),
  );
  log(`payer sold ${balance} USDC; waiting for the next charge to fail`);
  const pastDue = await waitFor(hookFor(sub.id, 'subscription.past_due'), 'past_due');
  results.push(['3 insufficient balance → failed charge → past_due', pastDue.verified]);

  // 4) Cancel from the wallet: the subscriber calls the contract directly.
  const account = await soroban.getAccount(payer.publicKey());
  const cancelTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(env.SUBSCRIPTION_CONTRACT_ID).call(
        'cancel',
        new Address(payer.publicKey()).toScVal(),
        nativeToScVal(contractSubId, { type: 'u64' }),
      ),
    )
    .setTimeout(120)
    .build();
  const preparedCancel = await soroban.prepareTransaction(cancelTx);
  preparedCancel.sign(payer);
  const sent = await soroban.sendTransaction(preparedCancel);
  log(`wallet-side cancel sent ${sent.hash}`);
  const canceled = await waitFor(hookFor(sub.id, 'subscription.canceled'), 'canceled', 180_000);
  results.push([
    '4 cancel from wallet → canceled (event sync)',
    canceled.verified && canceled.data.canceled_by === 'subscriber',
  ]);
  const final = await api('GET', `/v1/subscriptions/${sub.id}`);
  log(`final status: ${final.status}`);
} catch (error) {
  results.push([`FAILED: ${error.message}`, false]);
} finally {
  console.log('\nSubscription testnet E2E summary');
  for (const [name, ok] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  stopAll();
  process.exit(results.length === 4 && results.every(([, ok]) => ok) ? 0 : 1);
}
