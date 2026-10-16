#!/usr/bin/env bash
# Database half of `pnpm verify`: integration tests against local Supabase when
# packages/db or infra/supabase differ from origin/main (FORCE_DB=1 always runs).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
if [[ "${FORCE_DB:-0}" != "1" && -n "$base" ]] \
  && git diff --quiet "$base" -- packages/db infra/supabase apps/api \
  && git diff --quiet -- packages/db infra/supabase apps/api; then
  echo "packages/db, infra/supabase and apps/api unchanged; skipping DB integration tests"
  exit 0
fi

pnpm test:int
