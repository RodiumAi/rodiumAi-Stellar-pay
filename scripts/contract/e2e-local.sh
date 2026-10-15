#!/usr/bin/env bash
# End-to-end check against a local Stellar Quickstart (context §19 "Stellar local"):
# deploy → plan → subscribe (one signature) → too-early charge refused → cancel.
# Successful renewals need ledger time to pass a full interval (≥ 1 day), so they
# are covered by the contract's unit tests, which can move ledger time.
set -euo pipefail

# Test fixture only (not shipped). Pinned by digest; update deliberately.
IMAGE="stellar/quickstart@sha256:4f8dfd693deba57fddef7f0bc722e4782c2e606c8675e3adc5438cebae249295"
NAME=rp-quickstart
RPC=http://localhost:8000/rpc
NET=local
PRICE=99900000
INTERVAL=86400

cleanup() { [[ "${KEEP:-0}" == 1 ]] || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 8000:8000 "$IMAGE" --local --enable core,rpc,horizon >/dev/null
echo "waiting for quickstart RPC…"
for _ in $(seq 1 120); do
  if curl -sf -X POST "$RPC" -H 'content-type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"healthy"'; then break; fi
  sleep 5
done
curl -sf -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"healthy"'

stellar network add "$NET" --rpc-url "$RPC" --network-passphrase "Standalone Network ; February 2017" 2>/dev/null || true
addr() { stellar keys address "$1"; }
# Fund through friendbot directly: it starts later than RPC (and needs Horizon), and
# `keys generate --fund` does not fail loudly when it is not ready yet.
fund() {
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:8000/friendbot?addr=$1" >/dev/null; then return 0; fi
    sleep 5
  done
  echo "friendbot never funded $1" >&2
  return 1
}
for who in rp_admin rp_issuer rp_merchant rp_keeper rp_subscriber; do
  stellar keys generate "$who" --network "$NET" --overwrite >/dev/null
  fund "$(addr "$who")"
done
ISSUER="$(addr rp_issuer)"; MERCHANT="$(addr rp_merchant)"; SUBSCRIBER="$(addr rp_subscriber)"

echo "issuing test USDC and trustlines…"
TOKEN="$(stellar contract asset deploy --asset "USDC:$ISSUER" --source rp_issuer --network "$NET")"
for who in rp_merchant rp_subscriber; do
  stellar tx new change-trust --source "$who" --line "USDC:$ISSUER" --network "$NET" >/dev/null
done
stellar contract invoke --id "$TOKEN" --source rp_issuer --network "$NET" -- \
  mint --to "$SUBSCRIBER" --amount $((PRICE * 10)) >/dev/null

echo "deploying contract…"
CONTRACT="$(NETWORK=$NET SOURCE=rp_admin ADMIN="$(addr rp_admin)" MERCHANT="$MERCHANT" \
  KEEPER="$(addr rp_keeper)" TOKEN="$TOKEN" PRICE_STROOPS=$PRICE INTERVAL_SECS=$INTERVAL \
  "$(dirname "$0")/deploy.sh")"

LEDGER="$(curl -sf -X POST "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["sequence"])')"

invoke() { local src="$1"; shift; stellar contract invoke --id "$CONTRACT" --source "$src" --network "$NET" -- "$@"; }
balance() { stellar contract invoke --id "$TOKEN" --source rp_admin --network "$NET" -- balance --id "$1" | tr -d '"'; }
fail() { echo "E2E FAIL: $*" >&2; exit 1; }

echo "subscribing…"
SUB_ID="$(invoke rp_subscriber subscribe --subscriber "$SUBSCRIBER" --plan_id 1 --periods 3 --live_until_ledger $((LEDGER + 50000)))"
[[ "$SUB_ID" == 1 ]] || fail "expected subscription 1, got $SUB_ID"
[[ "$(balance "$MERCHANT")" == "$PRICE" ]] || fail "merchant did not receive the first period"
ALLOWANCE="$(stellar contract invoke --id "$TOKEN" --source rp_admin --network "$NET" -- \
  allowance --from "$SUBSCRIBER" --spender "$CONTRACT" | tr -d '"')"
[[ "$ALLOWANCE" == $((PRICE * 3)) ]] || fail "allowance $ALLOWANCE != $((PRICE * 3))"

echo "charging before due (must be refused)…"
if invoke rp_keeper charge --sub_id "$SUB_ID" >/dev/null 2>&1; then fail "charge before due succeeded"; fi
echo "charging as a non-keeper (must be refused)…"
if invoke rp_subscriber charge --sub_id "$SUB_ID" >/dev/null 2>&1; then fail "non-keeper charge succeeded"; fi
[[ "$(balance "$MERCHANT")" == "$PRICE" ]] || fail "merchant balance changed after refused charges"

echo "canceling…"
invoke rp_subscriber cancel --caller "$SUBSCRIBER" --sub_id "$SUB_ID" >/dev/null
invoke rp_admin get --sub_id "$SUB_ID" | grep -q Canceled || fail "subscription not canceled"

echo "E2E OK (contract $CONTRACT)"
