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
stellar contract build
cargo deny check
cargo audit
# Scout only analyses crates that depend on soroban-sdk (added in Sprint 4).
if ! grep -q '^soroban-sdk' subscription/Cargo.toml; then
  echo "no soroban-sdk dependency yet; skipping Scout"
elif command -v cargo-scout-audit >/dev/null; then
  report="$(mktemp -t scout.XXXXXX).json"
  cargo scout-audit -o json --output-path "$report" >/dev/null
  python3 ../scripts/scout-gate.py "$report"
else
  echo "cargo-scout-audit not installed; CI runs it" >&2
  exit 1
fi
