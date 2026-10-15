# Learning Log 02

Continuation of `learning01.md`. Same rules and entry format (see top of `learning01.md`). Read the hand-off summary at the bottom of `learning01.md` before adding entries here.

Cap: 200 lines. When full, write a hand-off summary and continue in `learning03.md`.

---

## Log

### 2026-10-15 · S4 · contract · decision

Subscription contract built; constructor instead of `init`

- What: `contracts/subscription` per context §14 on soroban-sdk 28.0.0 (29.x is < 14 days old). WASM 11.6 KB.
- Why: a separate `init` can be front-run between deploy and init (anyone could set themselves admin). `__constructor` runs atomically with deployment. Context §14.1 updated with this reason.
- Also: functions return `Result<_, Error>` (typed `contracterror`) so tests assert exact failures; events via `#[contractevent]` (SDK 28 deprecates `events().publish`); `stellar contract build` required (plain `cargo build --target wasm32v1-none` refused by SDK 28).
- Verified: 22 tests (every §14.3 invariant, exact `mock_auths`, proptest call sequences); clippy clean.

### 2026-10-15 · S4 · tooling · incident

Disk full broke Scout ("ld: write() failed, errno=28")

- What: 133 MB free of 233 GB; even tool output files failed with ENOSPC.
- Fix: user asked to remove all Docker containers/images; then `colima ssh -- sudo fstrim -av` returned the VM's freed blocks to macOS (deleting images alone frees nothing on the host). Deleted a 1.2 GB failed `cargo install` dir. → 16 GB free.
- Prevent: check `df -h` before heavy builds; Scout detectors + Rust targets need several GB.

### 2026-10-15 · S4 · security · fact

Free-tool results on the contract (plan §6)

- Scout 0.3.17: critical 0, medium 0, minor 0, enhancement 7 — 6× `storage_change_events` are false positives (Scout does not recognise `#[contractevent]`), 1× `soroban_version` accepted (14-day rule). Gate: `scripts/scout-gate.py` blocks critical/medium/minor.
- `cargo deny`: RUSTSEC-2024-0436 (`paste` unmaintained) ignored with reason — host-only proc-macro via soroban-env-host, not in the WASM.
- cargo-fuzz target `charge_sequence` runs in CI (libFuzzer cannot build locally); its body was compiled and run on 300 random inputs locally without libFuzzer.
- Komet deferred to S10: install requires Nix via `kup` (multi-GB, system-wide) — not done on this machine; run in CI in S10.
- Details: `docs/security/contract-review.md`.
