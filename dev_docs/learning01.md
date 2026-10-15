# Learning Log 01

Running, chronological log of the whole build — not tied to one sprint. Read top to bottom to see what happened at each stage, what went wrong and why.

**Rules**
- Cap: **200 lines per file**. When the next entry would push past 200, write the hand-off summary at the bottom, then continue in the next file (`learning02.md`, then `learning03.md`, …). Never edit a full file except to fix a factual error.
- Append only, newest at the bottom.
- Tag every entry with the stage (`S0`–`S11`) and area so entries can be grepped: `grep "S3" dev_docs/learning*.md`.
- Always include the **why** (root cause), not only the symptom. Quote errors exactly.
- Log: failures, surprises, decisions, workarounds, verified §17 facts, sprint start/end markers.
- Keep entries short — a few lines each. Long investigations go in the PR description and are linked here.

**Entry format**

```
### YYYY-MM-DD · S<n> · <area> · <type>
<title>
- What: <what happened; exact error if any>
- Why: <root cause>
- Fix: <what was done / decided>
- Verified: <test, command or source>
- Prevent: <test, lint rule, checklist item added>
- Refs: <commit / PR / tag / URL>
```

Types: `bug` · `test-fail` · `ci-fail` · `decision` · `workaround` · `fact` · `surprise` · `incident` · `milestone`

---

## Log

### 2026-10-15 · S0 · devdocs · decision
Build plan drafted; GitHub practice adopted
- What: Wrote `dev_docs/BUILD_PLAN.md` (12 layered sprints). Adopted trunk-based workflow: protected `main`, short-lived `sprint/NN-slug` branches, Conventional Commits, CI-gated PRs, `v0.N.0` tag per sprint.
- Why: Sprints are layers, not features; main RodiumAI app is already deployed, so this service must stay isolated and reach the main app only behind a feature flag (S11).
- Fix: Learning logs changed from per-sprint files to this rolling 200-line format.
- Refs: `dev_docs/BUILD_PLAN.md` §1
