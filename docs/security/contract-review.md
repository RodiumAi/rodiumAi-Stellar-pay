# Contract security review (self-run, plan §6)

No paid external audit. This file is the review record. Mainnet sign-off requires every
section below to be complete **for the exact WASM hash being deployed**.

## Build under review

| Item                         | Value                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| Crate                        | `contracts/subscription`                                                    |
| soroban-sdk                  | 28.0.0                                                                      |
| Build                        | `stellar contract build` (stellar-cli 28.1.0, Rust 1.98.0, `wasm32v1-none`) |
| WASM sha256 (2026-10-15, S4) | `81ea85d4feea5360a11cfdbcb4a17fa7e7d0c393a35bde0edfd9e8dc08ceca1b`          |
| Size                         | 11,604 bytes                                                                |

The hash changes with any code or toolchain change; record the final one at sign-off. CI prints it in the `contract` job.

## Tool results

### Scout 0.3.17 (CoinFabrik) — 2026-10-15

Critical 0 · Medium 0 · Minor 0 · Enhancement 7. CI blocks on critical/medium/minor (`scripts/scout-gate.py`).

| Detector                | Location                                                                | Verdict                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `soroban_version`       | `lib.rs:1`                                                              | Accepted. SDK 29.x exists but is < 14 days old (context §16.2). Re-check when it is eligible.                                                                                                                                                                                               |
| `storage_change_events` | `set_plan`, `subscribe`, `charge`, `cancel`, `set_paused`, `set_keeper` | False positive. Each function emits a `#[contractevent]` event (`PlanSet`, `SubCreated`, `Charged`, `Canceled`, `PausedSet`, `KeeperSet`); Scout only recognises the deprecated `env.events().publish`. Event emission is asserted in `state_changes_emit_events_with_the_subscription_id`. |

### Unit and property tests (`cargo test`) — 22 tests

Every invariant in context §14.3 has a dedicated test; auth tests use `mock_auths` with exact invocations (never `mock_all_auths`).

| Invariant                                                | Test                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Recipient is always the construction-time merchant       | `every_transfer_goes_to_the_construction_time_merchant`                                                |
| Price never changes after creation                       | `price_is_locked_even_if_the_plan_price_changes`                                                       |
| Second charge in a period fails                          | `second_charge_in_the_same_period_fails`                                                               |
| No charge on canceled / paused subscription, no transfer | `charge_on_canceled_subscription_fails_without_transfer`, `charge_while_paused_fails_without_transfer` |
| `price * periods` overflow aborts                        | `allowance_overflow_aborts`                                                                            |
| Only keeper charges                                      | `only_the_keeper_can_charge`                                                                           |
| Only subscriber/admin cancel; caller must sign           | `only_subscriber_or_admin_can_cancel`, `cancel_requires_the_callers_own_signature`                     |
| Only admin manages plans/pause/keeper/upgrade            | `only_admin_manages_plans_pause_keeper_and_upgrade`                                                    |
| No back-charging; ≤ 1 period per call                    | `late_charge_starts_a_fresh_period_and_never_back_charges`, `slightly_late_charge_keeps_the_schedule`  |
| Never charges past the approved allowance                | `charge_fails_once_the_allowance_is_used_up`                                                           |
| Random sequences never overcharge                        | proptest `charging_never_overcharges` (64 cases × ≤ 25 steps)                                          |

### Fuzzing (`cargo-fuzz`, target `charge_sequence`)

Random subscribe/advance/charge/cancel/pause/reprice sequences; asserts locked price, schedule bounds, exact merchant total, and never charging beyond the allowance. CI runs 120 s per push. Before each contract tag: run ≥ 1 h and record here.

| Date | Duration | Result                 |
| ---- | -------- | ---------------------- |
| —    | —        | pending first long run |

### Komet (Runtime Verification) — deferred to S10

Requires Nix (`kup`); to run in CI in Sprint 10 for property proofs of the §14.3 invariants.

### Certora Sunbeam (optional) — S10

## Manual checklist

| Check                                         | Status | Notes                                                                                                                |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| Every state-changing entrypoint requires auth | ✅     | `subscribe` (subscriber), `charge` (keeper), `cancel` (caller, then subscriber/admin check), admin functions (admin) |
| No initialisation front-running               | ✅     | `__constructor` runs atomically with deploy                                                                          |
| Merchant cannot be changed                    | ✅     | no setter; only `upgrade` could change it (admin multisig)                                                           |
| Checked arithmetic                            | ✅     | `checked_mul`/`checked_add` + `overflow-checks = true` in release                                                    |
| Allowance bounded                             | ✅     | `price * periods`, `live_until_ledger` chosen by backend from network TTL                                            |
| Pausable                                      | ✅     | `set_paused` stops `subscribe` and `charge`; `cancel` still works                                                    |
| TTL / archival                                | ✅     | instance and touched subscriptions extended to max TTL; worker extends active subscriptions (S9)                     |
| Events for every state change                 | ✅     | see Scout table                                                                                                      |
| Upgrade path controlled                       | ✅     | admin only; admin must be a multisig on mainnet                                                                      |
| Reentrancy                                    | ✅     | only calls the configured SAC token; state written before/after transfers inside one atomic invocation               |

## Sign-off (mainnet)

| Item                                                  | Done |
| ----------------------------------------------------- | ---- |
| Final WASM hash recorded and matches the deployed one | ☐    |
| Scout clean (critical/medium/minor = 0) on that hash  | ☐    |
| ≥ 1 h fuzz run clean on that hash                     | ☐    |
| Komet properties pass (S10)                           | ☐    |
| Exposure caps configured (plan §6.3)                  | ☐    |
| Admin and merchant are multisig accounts              | ☐    |
