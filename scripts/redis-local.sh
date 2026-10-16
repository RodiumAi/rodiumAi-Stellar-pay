#!/usr/bin/env bash
# Local Redis behind serverless-redis-http so @upstash/redis runs unchanged (context §19).
# Test fixtures only — pinned by digest. URL http://localhost:8079, token `rp-local-token`.
set -euo pipefail

REDIS_IMAGE="redis@sha256:0b2b77d3ea5078274795e3177cdbdada8b96316684a38911d528534ed679b5ec"
SRH_IMAGE="hiett/serverless-redis-http@sha256:65128347949bca511e448fd7238780d624573d74c22b79155a7563db19e9b678"
NET=rp-redis-net

case "${1:-start}" in
  start)
    docker rm -f rp-redis rp-srh >/dev/null 2>&1 || true
    docker network create "$NET" >/dev/null 2>&1 || true
    docker run -d --name rp-redis --network "$NET" "$REDIS_IMAGE" >/dev/null
    docker run -d --name rp-srh --network "$NET" -p 8079:80 \
      -e SRH_MODE=env -e SRH_TOKEN=rp-local-token -e SRH_CONNECTION_STRING=redis://rp-redis:6379 \
      "$SRH_IMAGE" >/dev/null
    for _ in $(seq 1 60); do
      if curl -sf -X POST -H 'authorization: Bearer rp-local-token' -H 'content-type: application/json' -d '["PING"]' http://localhost:8079/ | grep -q PONG; then
        echo "local Upstash-compatible Redis ready on http://localhost:8079"; exit 0
      fi
      sleep 1
    done
    echo "serverless-redis-http did not become ready" >&2; exit 1
    ;;
  stop)
    docker rm -f rp-redis rp-srh >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
