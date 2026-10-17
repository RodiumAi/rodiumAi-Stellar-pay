## What and why

<!-- One paragraph: what changes and why. -->

## Definition of done (docs/context.md §21)

- [ ] Types strict, lint clean, no new comments that restate code
- [ ] Tests added for new behaviour, including failure paths
- [ ] No new dependency without the §16.2 justification (maintenance, downloads, tree size, could 50 lines do?)
- [ ] Security scans green
- [ ] Migrations backward compatible
- [ ] New secret / external host / capability recorded in §12.4, §16.3 and `docs/security/`
- [ ] `docs/context.md` updated if a §2 decision or a §9–§10 contract changed

## Sprint gate

- [ ] `pnpm verify` green locally
- [ ] §17 facts verified, sources listed below

## Self-review (solo developer — required before merge)

- [ ] Read the full diff top to bottom in the GitHub UI
- [ ] No secrets, tokens, customer refs or decrypted values in code, logs, tests or fixtures
- [ ] Every money path uses `bigint` stroops; no float math
- [ ] Contract changes: Scout / Komet / fuzz results recorded in `docs/security/contract-review.md`

## §17 sources

<!-- facts verified in this PR and where -->
