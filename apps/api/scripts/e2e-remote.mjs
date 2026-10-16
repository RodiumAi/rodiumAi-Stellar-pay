// End-to-end test against a DEPLOYED StelPay (default https://stelpay.forge.rodiumai.io) on
// testnet: proves the hosted API, worker and signer work together, not just the health
// checks. Uses a throwaway payer (friendbot + testnet USDC from the DEX) and polls the API
// for state changes (works before the main app's webhook endpoint exists).
//   pnpm e2e:remote            (needs API_HMAC_KEYS, MERCHANT_ADDRESS, SUBSCRIPTION_CONTRACT_ID in .env)
import { randomBytes } from 'node:crypto';
import { signRequest } from '@rp/security/hmac-auth';
import {
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  Memo,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

process.chdir(new URL('../../../', import.meta.url).pathname);
process.loadEnvFile('.env');
const env = process.env;
const API = (env.STELPAY_BASE_URL ?? 'https://stelpay.forge.rodiumai.io').replace(/\/$/, '');
const RETURN = env.STELPAY_RETURN_ORIGIN ?? 'https://rodiumai.io';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const soroban = new rpc.Server('https://soroban-testnet.stellar.org');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
            'idempotency-key': `remote_${randomBytes(8).toString('hex')}`,
          }
        : {}),
    },
    ...(method === 'POST' ? { body: raw } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(check, what, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(4000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function classic(kp, op, memo) {
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

async function checkout(token, payer) {
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
  return (
    await fetch(`${API}/c/${token}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr: tx.toXdr() }),
    })
  ).json();
}

const results = [];
const ok = (name, pass, detail = '') => {
  results.push([name, pass]);
  log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const ready = await (await fetch(`${API}/v1/health/ready`)).json();
  ok('deployed service ready', ready.status === 'ready', JSON.stringify(ready.checks));

  const payer = Keypair.random();
  await fetch(`https://friendbot.stellar.org/?addr=${payer.publicKey()}`);
  await classic(payer, Operation.changeTrust({ asset: USDC }));
  await classic(
    payer,
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: '200',
      destination: payer.publicKey(),
      destAsset: USDC,
      destAmount: '12',
      path: [],
    }),
  );
  log(`payer ${payer.publicKey()} funded with 12 testnet USDC`);

  // A) one-time payment through the hosted checkout
  const a = await api('POST', '/v1/payments', {
    merchant_order_id: `remote_a_${randomBytes(3).toString('hex')}`,
    customer_ref: 'usr_remote_e2e',
    description: 'Remote E2E — checkout',
    amount: { currency: 'USD', value_minor: 200 },
    return_url: `${RETURN}/billing/return`,
  });
  const page = await fetch(`${API}/c/${a.checkout_url.split('/c/')[1]}`);
  log(`checkout page ${page.status}; submitting payment of ${a.amount_due.value} USDC`);
  await checkout(a.checkout_url.split('/c/')[1], payer);
  const aDone = await waitFor(async () => {
    const p = await api('GET', `/v1/payments/${a.id}`);
    return p.status === 'confirmed' ? p : null;
  }, 'A confirmed');
  ok('A checkout payment confirmed by the AWS worker', aDone.status === 'confirmed');

  // B) wallet payment with the memo (QR / SEP-7 path), underpaid then topped up
  const b = await api('POST', '/v1/payments', {
    merchant_order_id: `remote_b_${randomBytes(3).toString('hex')}`,
    customer_ref: 'usr_remote_e2e',
    description: 'Remote E2E — underpay',
    amount: { currency: 'USD', value_minor: 200 },
    return_url: `${RETURN}/billing/return`,
  });
  const html = await (await fetch(`${API}${new URL(b.checkout_url).pathname}`)).text();
  const memo = /RP[0-9A-HJKMNP-TV-Z]{12}/.exec(html)[0];
  await classic(
    payer,
    Operation.payment({ destination: env.MERCHANT_ADDRESS, asset: USDC, amount: '1' }),
    Memo.text(memo),
  );
  await waitFor(
    async () => (await api('GET', `/v1/payments/${b.id}`)).status === 'underpaid',
    'B underpaid',
  );
  await classic(
    payer,
    Operation.payment({ destination: env.MERCHANT_ADDRESS, asset: USDC, amount: '1.5' }),
    Memo.text(memo),
  );
  const bDone = await waitFor(async () => {
    const p = await api('GET', `/v1/payments/${b.id}`);
    return p.status === 'confirmed' ? p : null;
  }, 'B confirmed');
  ok(
    'B underpaid → topped up → confirmed',
    bDone.status === 'confirmed',
    `received ${bDone.amount_received.value} USDC`,
  );

  // C) subscription: subscribe once, keeper charge via the in-task signer, wallet cancel
  const sub = await api('POST', '/v1/subscriptions', {
    merchant_subscription_ref: `remote_${randomBytes(3).toString('hex')}`,
    customer_ref: 'usr_remote_e2e',
    plan_code: 'pro_monthly',
    return_url: `${RETURN}/billing/return`,
  });
  const submitted = await checkout(sub.checkout_url.split('/c/')[1], payer);
  log(`subscribe submit → ${JSON.stringify(submitted)}`);
  const active = await waitFor(
    async () => {
      const s = await api('GET', `/v1/subscriptions/${sub.id}`);
      return s.status === 'active' && s.next_charge_at ? s : null;
    },
    'subscription active',
    120_000,
  );
  ok('C1 subscribed with one signature → active', true, `next charge ${active.next_charge_at}`);
  // A real renewal comes from the contract's `charged` event, which moves current_period_end.
  // (Claiming a charge only pushes next_charge_at out by a 10-minute lease — not proof.)
  const renewed = await waitFor(
    async () => {
      const s = await api('GET', `/v1/subscriptions/${sub.id}`);
      return s.current_period_end && s.current_period_end > active.current_period_end ? s : null;
    },
    'keeper charge (renewal)',
    600_000,
  );
  ok(
    'C2 keeper charge signed in AWS → renewed',
    renewed.status === 'active',
    `period end ${active.current_period_end} → ${renewed.current_period_end}`,
  );
  // The on-chain id is the subscribe transaction's return value (not part of the API view).
  const subTx = await soroban.getTransaction(submitted.hash);
  const contractSubId = BigInt(scValToNative(subTx.returnValue));
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
  const prepared = await soroban.prepareTransaction(cancelTx);
  prepared.sign(payer);
  await soroban.sendTransaction(prepared);
  const canceled = await waitFor(
    async () => {
      const s = await api('GET', `/v1/subscriptions/${sub.id}`);
      return s.status === 'canceled' ? s : null;
    },
    'canceled from wallet',
    180_000,
  );
  ok('C3 canceled from the wallet → canceled', canceled.status === 'canceled');
} catch (error) {
  ok(`FAILED: ${error.message}`, false);
} finally {
  console.log(
    `\nRemote E2E against ${API}: ${results.every(([, p]) => p) ? 'PASS' : 'FAIL'} (${results.filter(([, p]) => p).length}/${results.length})`,
  );
  process.exit(results.every(([, p]) => p) ? 0 : 1);
}
