// Load sanity test (plan S11): not a benchmark — checks the API stays correct and fast under
// a burst at the size the main app can produce. Starts the compiled API with .env (dev DB +
// Upstash), then:
//   1. 100 signed payment creations, 10 in flight — all 201, p95 under budget
//   2. 100 checkout status polls, 20 in flight — all 200 or 429, p95 under budget
//   3. 60 more creations past the 120/min key limit — the limit answers 429, never 5xx
//   pnpm build:all && pnpm load:sanity
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { signRequest } from '@rp/security/hmac-auth';

process.chdir(new URL('../../../', import.meta.url).pathname);
process.loadEnvFile('.env');
const env = process.env;
const API = `http://localhost:${env.PORT ?? '8080'}`;
// Our own share of a request's p95; Upstash round trips are measured and added on top, so the
// check means the same on a laptop far from Upstash as in-region (creation: nonce + rate
// limit = 2 calls; status poll: rate limit + status cache = 2 calls).
const OWN_P95_MS = Number(env.LOAD_OWN_P95_MS ?? 300);

const api = spawn(process.execPath, ['--env-file=.env', 'apps/api/dist/main.js'], {
  env,
  stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => api.kill('SIGTERM'));

const [keyId, secret] = env.API_HMAC_KEYS.split(',')[0].split(':');
function signed(method, path, body) {
  const raw = Buffer.from(body === undefined ? '' : JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  return fetch(`${API}${path}`, {
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
            'idempotency-key': `load_${randomBytes(8).toString('hex')}`,
          }
        : {}),
    },
    ...(method === 'POST' ? { body: raw } : {}),
  });
}
const createPayment = () =>
  signed('POST', '/v1/payments', {
    merchant_order_id: `load_${randomBytes(4).toString('hex')}`,
    customer_ref: 'usr_load',
    description: 'Load sanity',
    amount: { currency: 'USD', value_minor: 100 },
    return_url: `${env.RETURN_URL_ORIGINS.split(',')[0]}/billing/return`,
  });

async function run(n, concurrency, fn) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < n) {
        next += 1;
        const t = performance.now();
        const res = await fn().catch((e) => ({ status: 0, error: e }));
        results.push({ status: res.status, ms: performance.now() - t, res });
      }
    }),
  );
  return results;
}
const pct = (xs, p) =>
  xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const tally = (rs) =>
  Object.entries(Object.groupBy(rs, (r) => r.status))
    .map(([s, v]) => `${s}×${v.length}`)
    .join(' ');

const checks = [];
const check = (name, ok, detail) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
};

try {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${API}/v1/health/ready`).catch(() => null))?.ok) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const pings = await run(20, 1, () =>
    fetch(`${env.UPSTASH_REDIS_REST_URL}/ping`, {
      headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    }),
  );
  const upstash = pct(
    pings.map((r) => r.ms),
    95,
  );
  console.log(`Upstash round trip p95 ${upstash.toFixed(0)} ms (baseline, not our code)`);

  const created = await run(100, 10, createPayment);
  const ms = created.map((r) => r.ms);
  check(
    '1 100 payment creations',
    created.every((r) => r.status === 201) && pct(ms, 95) < OWN_P95_MS + 2 * upstash,
    `${tally(created)}; p50 ${pct(ms, 50).toFixed(0)} ms, p95 ${pct(ms, 95).toFixed(0)} ms (budget ${(OWN_P95_MS + 2 * upstash).toFixed(0)})`,
  );

  const first = created.find((r) => r.status === 201);
  const token = first ? (await first.res.json()).checkout_url.split('/c/')[1] : '';
  const polls = await run(100, 20, () => fetch(`${API}/c/${token}/status`));
  const pms = polls.map((r) => r.ms);
  check(
    '2 100 checkout status polls',
    polls.every((r) => r.status === 200 || r.status === 429) &&
      pct(pms, 95) < OWN_P95_MS + 2 * upstash,
    `${tally(polls)}; p50 ${pct(pms, 50).toFixed(0)} ms, p95 ${pct(pms, 95).toFixed(0)} ms (budget ${(OWN_P95_MS + 2 * upstash).toFixed(0)})`,
  );

  const burst = await run(60, 10, createPayment);
  check(
    '3 burst past the 120/min key limit',
    burst.some((r) => r.status === 429) && burst.every((r) => r.status === 201 || r.status === 429),
    tally(burst),
  );
} catch (error) {
  check(`FAILED: ${error.message}`, false, '');
}
process.exit(checks.length === 3 && checks.every(([, ok]) => ok) ? 0 : 1);
