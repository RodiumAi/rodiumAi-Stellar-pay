#!/usr/bin/env bash
# Deploys the subscription contract and creates its first plan.
#
#   NETWORK=testnet SOURCE=<stellar-cli identity that pays fees> \
#   ADMIN=G... MERCHANT=G... KEEPER=G... TOKEN=C... \
#   PLAN_ID=1 PRICE_STROOPS=99900000 INTERVAL_SECS=2592000 \
#   scripts/contract/deploy.sh
#
# ADMIN must be able to sign `set_plan` with SOURCE (on mainnet: a multisig flow instead).
# TOKEN defaults to the network's Circle USDC SAC from packages/config/src/network.ts.
set -euo pipefail

: "${NETWORK:?testnet | mainnet | local}"
: "${SOURCE:?stellar-cli identity name}"
: "${ADMIN:?}" "${MERCHANT:?}" "${KEEPER:?}"
PLAN_ID="${PLAN_ID:-1}"
PRICE_STROOPS="${PRICE_STROOPS:-}"
INTERVAL_SECS="${INTERVAL_SECS:-}"

case "$NETWORK" in
  testnet) TOKEN="${TOKEN:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}" ;;
  mainnet) TOKEN="${TOKEN:-CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75}" ;;
  *) : "${TOKEN:?TOKEN is required for $NETWORK}" ;;
esac

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/contracts"
# WASM=target/e2e/subscription-test-short-intervals.wasm deploys the E2E-only build.
if [[ -z "${WASM:-}" ]]; then
  stellar contract build >&2
  WASM=target/wasm32v1-none/release/subscription.wasm
fi
if [[ "$NETWORK" == "mainnet" && "$WASM" == *test-short-intervals* ]]; then
  echo "refusing to deploy the test-short-intervals build to mainnet" >&2
  exit 1
fi
echo "wasm sha256: $(shasum -a 256 "$WASM" | cut -d' ' -f1)" >&2

CONTRACT_ID="$(stellar contract deploy --wasm "$WASM" --source "$SOURCE" --network "$NETWORK" -- \
  --admin "$ADMIN" --token "$TOKEN" --merchant "$MERCHANT" --keeper "$KEEPER")"
echo "contract: $CONTRACT_ID" >&2

if [[ -n "$PRICE_STROOPS" && -n "$INTERVAL_SECS" ]]; then
  stellar contract invoke --id "$CONTRACT_ID" --source "$SOURCE" --network "$NETWORK" -- \
    set_plan --plan_id "$PLAN_ID" --price "$PRICE_STROOPS" --interval_secs "$INTERVAL_SECS" --active true >&2
  echo "plan $PLAN_ID: price=$PRICE_STROOPS interval=$INTERVAL_SECS" >&2
fi

echo "$CONTRACT_ID"
