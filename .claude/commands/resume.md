---
description: Resume the sprint build from the learning log hand-off
---

Resume the RodiumAI crypto-pay build from where the last session stopped.

1. Find the newest `dev_docs/learningNN.md` and read its "▶ RESUME HERE" section in full, then the hand-off summary at the bottom of the previous learning file.
2. Read the next sprint's section in `dev_docs/BUILD_PLAN.md` and the context sections it references in `docs/context.md`.
3. Check state before acting: `git status`, `git log --oneline -5`, `gh pr list`, and whether the previous sprint's PR is merged and tagged. If a PR is still open with green CI, merge it and tag it as the notes describe; if CI failed, fix that first.
4. Then continue the next sprint following the workflow in the resume notes, and tell me in plain language what you are starting.
