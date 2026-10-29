# Admin dashboard (`apps/admin`)

A read-only operations view for the people who run StelPay: payments, on-chain receipts
(including unmatched ones), webhook deliveries, treasury balance and service health. It changes
nothing: refunds, key rotation and settings stay in the runbooks until later phases.

## Security model

- **Login happens before the app.** In production the load balancer's `authenticate-cognito`
  (or `authenticate-oidc`) action signs the user in, with MFA enforced by the identity provider,
  before a request is forwarded. The app then verifies the load balancer's signed
  `x-amzn-oidc-data` token itself (ES256 signature, the expected load balancer as `signer`,
  expiry) and allows only emails in `ADMIN_ALLOWED_EMAILS`. A missing or invalid token is a 401
  even if the network path is misconfigured.
- **Read-only data access.** The app connects as `rp_readonly` (`SELECT` only, read-only
  transactions, 60 s statement timeout). It never sees API keys, webhook keys or the field-data
  keys, and it cannot decrypt `customer_ref`.
- **Its own service.** Separate container, task role and secret, so the public API gains no new
  permissions. The listener rule forwards only the dashboard path (and the login callback).
- **Hardened pages.** Server-rendered HTML with escaping by default (`src/html.ts`), no scripts
  (`script-src` is not allowed at all), styles only from its own stylesheet, `no-store`,
  `noindex`, never framed. Each request is logged with the signed-in email (access trail).
- **Rate-limited** per client address (120 requests a minute; the load balancer is the only
  trusted proxy hop). Refused sign-ins and rate-limit hits are logged with `security: true`.
- **Mounted under a configurable path** (`ADMIN_BASE_PATH`); the path itself is not a secret.

## Configuration

| Variable                | Required    | Meaning                                                             |
| ----------------------- | ----------- | ------------------------------------------------------------------- |
| `ADMIN_BASE_PATH`       | yes         | Path the dashboard lives under, e.g. `/admin`                       |
| `ADMIN_ALLOWED_EMAILS`  | yes         | Comma-separated emails allowed in (case-insensitive)                |
| `ADMIN_AUTH`            | no (`alb`)  | `alb` (production) or `dev` (no sign-in; refused in production)     |
| `ADMIN_ALB_ARN`         | with `alb`  | ARN of the load balancer whose tokens are accepted                  |
| `ADMIN_LOGOUT_URL`      | no          | Identity-provider logout URL; enables "Sign out"                    |
| `ADMIN_DEV_EMAIL`       | with `dev`  | Identity used in dev mode                                           |
| `DATABASE_URL_READONLY` | yes         | Connection URL for `rp_readonly`                                    |
| `RP_STELLAR_NETWORK`    | yes         | `testnet` or `mainnet` (explorer links, USDC issuer, Horizon)       |
| `MERCHANT_ADDRESS`      | yes         | Treasury account shown with its live balance                        |
| `ADMIN_API_READY_URL`   | no          | The API's `/v1/health/ready` URL, shown on the overview             |
| `PORT`                  | no (`8081`) | Listen port; `/health/live` (no sign-in) is the load balancer check |

## Local run

```sh
pnpm typecheck
NODE_ENV=development ADMIN_AUTH=dev ADMIN_DEV_EMAIL=you@example.com \
  ADMIN_ALLOWED_EMAILS=you@example.com ADMIN_BASE_PATH=/admin \
  node --env-file=.env apps/admin/dist/main.js     # then open http://localhost:8081/admin
```

`.env` must contain `DATABASE_URL_READONLY`, `RP_STELLAR_NETWORK` and `MERCHANT_ADDRESS`.

## Image

`infra/docker/Dockerfile --target admin`, built, checked (`scripts/check-image.sh`), scanned and
signed like the other services.
