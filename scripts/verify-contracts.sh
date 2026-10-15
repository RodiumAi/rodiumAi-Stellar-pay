#!/usr/bin/env bash
# Rust half of `pnpm verify`. Runs only when contracts/ differs from origin/main
# (or always when FORCE_CONTRACTS=1), so TypeScript-only pushes stay fast.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
if [[ "${FORCE_CONTRACTS:-0}" != "1" && -n "$base" ]] \
  && git diff --quiet "$base" -- contracts/ \
  && git diff --quiet -- contracts/; then
  echo "contracts/ unchanged; skipping Rust checks"
  exit 0
fi

cd contracts
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo deny check
cargo audit
if command -v cargo-scout-audit >/dev/null; then
  cargo scout-audit
else
  echo "cargo-scout-audit not installed; CI runs it" >&2
fi
