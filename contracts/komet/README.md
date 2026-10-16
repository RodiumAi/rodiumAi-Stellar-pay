# Komet property tests: blocked (checked 2026-10-16)

Komet (Runtime Verification) was meant to run property tests and proofs for the
context §14.3 invariants in Sprint 10 (see `docs/security/contract-review.md`).
It cannot run our contract yet, so this directory holds no test crate and CI has
no `contract-komet` job.

## Why

Checked against Komet **v0.1.89** (released 2026-08-20, the newest tag; `master`
is the same commit `a078e29`).

1. **Missing host functions for soroban-sdk 28.** Our WASM imports
   `m.b` (`sparse_map_new_from_linear_memory`) and `m.c`
   (`sparse_map_unpack_to_linear_memory`). Both are new in protocol 28
   (`soroban-env-common-28.0.2/env.json`, `min_supported_protocol: 28`).
   soroban-sdk 28 calls them every time it reads a `#[contracttype]` struct
   (`Plan`, `Subscription`) and every time it publishes a `#[contractevent]`.
   Komet's `host/map.md` only implements `m._` through `m.a`, so `set_plan`,
   `subscribe` and `charge` cannot run in Komet. Komet's own examples and test
   project use soroban-sdk 22.0.1, and its Nix package bundles stellar-cli 23.1.3.
2. **Auth is a no-op.** In `host/address.md`, `require_auth` always succeeds
   ("auth system is out of scope for now"). Komet could not check "only the
   keeper can charge" or any other auth invariant, even with fix 1.
3. **No constructor or Stellar Asset Contract.** `kasmer_create_contract` takes
   only an address and a WASM hash, so `__constructor` is never run with
   arguments. There is also no built-in SAC, so a mock token would be needed for
   `transfer`, `approve` and `transfer_from`.

## What covers §14.3 today

- `contracts/subscription/src/test.rs`: unit tests for every invariant, with
  exact `mock_auths`, plus two proptests: `charging_never_overcharges` and the
  model-based `random_operations_keep_every_invariant` (random sequences of time
  steps, keeper and stranger charges, cancels, pauses and plan price changes
  against the real contract, real auth and a real SAC; checks recipient, locked
  price, one charge per period, keeper-only charging, no charge after cancel or
  while paused, and that the contract never holds funds — after every step). A
  mutation check (removing the pause guard in `charge`) makes it fail.
- `contracts/fuzz/fuzz_targets/charge_sequence.rs`: cargo-fuzz in CI.
- Scout static analysis.

## When to check again

Check again when a Komet release that implements `m.b` and `m.c` (protocol 28)
is at least 14 days old. A real `require_auth` would also be needed before
Komet can check the auth invariants.
