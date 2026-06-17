---
allowed-tools: Bash, Glob, Grep, Read, Edit, Write, Task, Skill
description: Run the full PR-gate suite continuously, auto-fixing issues; pause only when a decision is truly the user's
---

Run the **full suite of PR gates** on the current branch **continuously**: run every gate, fix any issues you find, re-run, and repeat until the suite is clean. Only pause to ask the user when a decision is genuinely theirs to make (see "When to pause").

**Optional argument:** $ARGUMENTS — if a scope is given (e.g. a directory), narrow `/code-review` and `/test-review` to it. Otherwise default every gate to branch-diff vs `origin/main`.

## Operating mode

- **Autonomous by default.** Address issues yourself — apply fixes, re-run the failing gate, keep going. Do not narrate every option or wait for approval between gates. This mirrors the user's standing preference (see `[[autonomous-impl-tests-docs]]`): run approved work continuously without step-by-step check-ins, always including tests and `.context` doc updates when behavior changes.
- **Loop until green.** A gate that triggers a fix must be re-run after the fix. The run is done only when a full pass produces no new actionable findings.
- **Commit hygiene.** When the branch already has a PR commit, **amend** gate fixes into it — never a separate "fix review" commit (see `[[commit-review-fixes-into-branch]]`). Only commit/push when the user has asked you to; otherwise leave fixes staged in the working tree and report them.

## Gate sequence

Run in this order. Stop-and-fix at each stage before moving on; cheap gates first so failures surface fast.

### 1. Automated validation (`/pre-pr`)

Run the `/pre-pr` skill. It covers `npm run validate` (type-check + lint + format), `npm run test:coverage`, migration-drift check, and the anti-pattern scan. Fix every failure it reports, re-running `npm run validate` / the relevant check until clean. Do not proceed while automated checks are red.

### 2. Test quality (`/test-review`)

Run `/test-review` (scoped to $ARGUMENTS if given, else branch diff). It writes a confidence-scored report to `.reviews/`. Apply findings ≥80 with `/test-fix --all`. Re-run `/test-review` only if you changed source under test; do not loop reflexively.

### 3. Correctness (`/code-review`)

Run `/code-review` on the diff (scoped to $ARGUMENTS if given). Apply the high-confidence findings. Re-run `npm run validate` after any code change.

### 4. Security (`/security-review`)

Run `/security-review` on the pending branch changes. Triage findings: fix clear issues; for anything ambiguous or risky, pause (see below).

### 5. CHANGELOG check

If the diff touches the public surface (a named seam, documented API, or published Prisma model — see `VERSIONING.md`), confirm `CHANGELOG.md`'s `## [Unreleased]` has a matching entry; add one if missing. App-only models/routes get **no** changelog entry (see `[[changelog-platform-scoped]]`).

## When to pause and ask

Pause **only** when proceeding would require guessing at something that is genuinely the user's call:

- A fix changes intended product behavior or a public API contract (not a mechanical correction).
- A security finding's remediation has real trade-offs (e.g. loosening auth, disabling a check).
- Two gates conflict, or a fix would undo something that looks deliberate.
- A destructive or hard-to-reverse action (DB reset, force-push, deleting non-generated files).
- A finding is real but the right fix is ambiguous and the choices materially differ.

When you must pause, ask one tight question with a recommended default — don't dump the whole option space.

## Final report

End with a concise status table: each gate → PASS / FIXED (n) / NEEDS INPUT, the files you changed, and whether anything is awaiting the user. State plainly if a gate was skipped (e.g. migration drift N/A) rather than implying full coverage.
