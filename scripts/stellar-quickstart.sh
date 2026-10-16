#!/usr/bin/env bash
# Local Stellar network for integration tests (context §19 "Stellar local").
# Test fixture only — pinned by digest; Horizon is enabled because friendbot needs it.
set -euo pipefail

IMAGE="stellar/quickstart@sha256:4f8dfd693deba57fddef7f0bc722e4782c2e606c8675e3adc5438cebae249295"
NAME="${RP_QUICKSTART_NAME:-rp-quickstart}"
RPC=http://localhost:8000/rpc

case "${1:-start}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 8000:8000 "$IMAGE" --local --enable core,rpc,horizon >/dev/null
    echo "waiting for Quickstart (rpc + friendbot; friendbot answers 400 without ?addr when up)…"
    for _ in $(seq 1 120); do
      if curl -sf -X POST "$RPC" -H 'content-type: application/json' \
           -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"healthy"' \
         && [[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/friendbot)" == 400 ]] \
         && curl -sf http://localhost:8000/ | grep -q '"history_latest_ledger": *[1-9]'; then
        echo "Quickstart ready"; exit 0
      fi
      sleep 5
    done
    echo "Quickstart did not become ready" >&2; exit 1
    ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
