# Dependency versions (context §17)

Rule (§3, §16.2): newest stable release within the listed major, published at least 14 days before adoption. Verified 2026-10-15 (cutoff 2026-10-01) against the npm registry (`npm view <pkg> time`), nodejs.org/dist/index.json, crates.io, PyPI and GitHub releases.

## Runtime and toolchain

| Item           | Pinned  | Published  | Newest seen          | Note                                                         |
| -------------- | ------- | ---------- | -------------------- | ------------------------------------------------------------ |
| Node.js 24 LTS | 24.21.0 | 2026-09-07 | 24.22.0 (2026-10-14) | newest is < 14 days                                          |
| pnpm 10        | 10.34.6 | 2026-09-28 | 10.34.7 (2026-10-12) | newest is < 14 days                                          |
| Rust           | 1.98.0  | 2026-08-18 | —                    | `contracts/rust-toolchain.toml`                              |
| stellar-cli    | 28.1.0  | 2026-09-26 | —                    | prebuilt binary, sha256 matched to the GitHub release digest |

## Installed in Sprint 0 (dev tooling)

| Package                      | Pinned           | Published                         |
| ---------------------------- | ---------------- | --------------------------------- |
| typescript (5.x per §3)      | 5.9.3            | 2025-09-30                        |
| eslint                       | 10.11.0          | 2026-09-18                        |
| typescript-eslint            | 8.71.0           | 2026-09-28                        |
| eslint-plugin-security       | 4.2.0            | 2026-10-01                        |
| prettier                     | 3.9.9            | 2026-09-23                        |
| vitest / @vitest/coverage-v8 | 5.0.3            | 2026-09-30                        |
| @types/node (24)             | 24.19.0          | 2026-09-25                        |
| fast-check (S1)              | 4.10.2           | 2026-09-19                        |
| zod (S2, config)             | 4.6.5            | 2026-09-13                        |
| fastify (S6)                 | 5.12.5           | 2026-09-16                        |
| @fastify/helmet (S6)         | 13.1.1           | 2026-08-19                        |
| @upstash/redis (S6)          | 1.39.0           | 2026-09-21                        |
| @upstash/ratelimit (S6)      | 2.2.0            | 2026-09-23                        |
| actions/cache (CI)           | v5.1.0 `caa2961` | 2026-06-26                        |
| vite (S8, checkout build)    | 8.3.2            | 2026-10-01                        |
| @stellar/freighter-api (S8)  | 6.0.1            | 2025-12-03                        |
| uqr (S8, QR SVG, 0 deps)     | 0.1.3            | 2026-04-03                        |
| axe-core (dev)               | 4.13.0           | 2026-08-05                        |
| jsdom / @types/jsdom (dev)   | 30.1.1 / 30.0.0  | 2026-09-22                        |
| pino (S2, security)          | 10.3.1           | 2026-02-09 (10.4.0 is < 14 days)  |
| @aws-sdk/client-kms (S10)    | 3.1145.0         | 2026-10-01 (+25 packages, ~15 MB) |

## Selected for later sprints (re-check age when installed)

| Package        | Version         | Published               | Sprint |
| -------------- | --------------- | ----------------------- | ------ |
| kysely         | 0.29.6          | 2026-09-16              | S3     |
| pg / @types/pg | 8.23.1 / 8.23.1 | 2026-09-30 / 2026-08-17 | S3     |
| testcontainers | 12.2.0          | 2026-09-28              | S3     |

TypeScript 7 (native) exists, but §3 specifies 5.x and typescript-eslint 8.71 supports `<6.1.0`.

## CI tooling

| Tool                      | Pinned                   | Published  |
| ------------------------- | ------------------------ | ---------- |
| actions/checkout          | v7.0.1 (`3d3c42e`)       | 2026-07-20 |
| actions/setup-node        | v7.0.0 (`8207627`)       | 2026-07-14 |
| pnpm/action-setup         | v6.1.0 (`ea17c68`)       | 2026-09-05 |
| github/codeql-action      | v4.38.2 (`2892aa5`)      | 2026-09-24 |
| google/osv-scanner-action | v2.6.0 (`a345acf`)       | 2026-09-14 |
| taiki-e/install-action    | v2.87.22 (`83ac0ad`)     | 2026-09-29 |
| Swatinem/rust-cache       | v2.9.2 (`6323deb`)       | 2026-08-06 |
| gitleaks                  | 8.30.1 (sha256-verified) | 2026-03-21 |
| semgrep                   | 1.178.0                  | 2026-09-23 |

## Network facts (context §17)

| Fact                 | Value                                                      | Source                                                                 |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| USDC issuer, testnet | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | developers.circle.com/stablecoins/usdc-contract-addresses (2026-10-15) |
| USDC issuer, mainnet | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | same                                                                   |
| USDC SAC, testnet    | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | `stellar contract id asset --asset USDC:<issuer> --network testnet`    |
| USDC SAC, mainnet    | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | same, `--network mainnet`                                              |

## Contract (Rust, Sprint 4)

| Crate / tool                            | Pinned                                        | Published                                                                     | Note                            |
| --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| soroban-sdk                             | 28.0.0                                        | 2026-09-18                                                                    | 29.0.0/29.0.1 are < 14 days old |
| proptest (dev)                          | 1.11.0                                        | 2026-03-24                                                                    | 1.12.0 is < 14 days old         |
| libfuzzer-sys (fuzz)                    | 0.4.13                                        | 2026-06-04                                                                    |                                 |
| arbitrary (fuzz)                        | 1.3.2                                         | —                                                                             | soroban-sdk 28 requires `~1.3`  |
| cargo-fuzz (CI)                         | 0.13.2                                        | 2026-06-09                                                                    | nightly-2025-09-18              |
| cargo-scout-audit                       | 0.3.17                                        | —                                                                             | detectors on nightly-2025-09-18 |
| stellar-cli (CI, linux)                 | 28.1.0                                        | 2026-09-26                                                                    | sha256 `c1680dee…6462`          |
| SDF testnet RPC retention               | ~2,090 ledgers (~3 h)                         | `startLedger must be within the ledger range: 5214911 - 5216998` (2026-10-15) |
| SDF testnet RPC classic events          | emitted (CAP-67 `transfer` for `payment` ops) | sampled 40 USDC transfer events: 39 `invokeHostFunction`, 1 `payment`         |
| Stellar Quickstart (tests)              | digest `4f8dfd69…9295`                        | Docker Hub `stellar/quickstart:latest`, 2026-10-12; test fixture only         |
| Stellar Wallets Kit 2.7.0 (not adopted) | ~234 packages, 481 MB `node_modules`          | measured with a clean `npm install` (2026-10-16)                              |
| Testnet USDC liquidity                  | 50 USDC ≈ 56 XLM via `paths/strict-receive`   | horizon-testnet (2026-10-16)                                                  |
