#!/usr/bin/env bash
# Release gate (context §19): the full scripted testnet run before every release —
# one-time payment, underpayment + top-up, expiry (pnpm e2e:testnet), then subscription
# create, charge, failed charge and wallet cancel (pnpm e2e:testnet:subscriptions).
# Builds first; both suites start their own API/worker(/signer) from the builds.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pnpm -s build:all || { echo "build failed"; exit 1; }
status=0
for suite in e2e:testnet e2e:testnet:subscriptions; do
  echo "── $suite"
  pnpm -s "$suite" || status=1
done
echo
echo "release E2E ($started → $(date -u +%H:%M:%SZ)): $([[ $status -eq 0 ]] && echo PASS || echo FAIL) at $(git rev-parse --short HEAD)"
exit "$status"
