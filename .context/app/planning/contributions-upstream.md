# Contributions upstream

Record of platform improvements **ConQuest contributed back to Sunrise**. This is the
resolved-counterpart to [`upstream-gaps.md`](./upstream-gaps.md): that ledger tracks
open gaps in Sunrise's public surface; this one records the gaps ConQuest closed
_upstream_ — fixed in Sunrise and pulled down, not forked in place.

It exists for two reasons. First, **discipline**: per the
[building-on-Sunrise](../../../CUSTOMIZATION.md) model, a generic missing seam is fixed
upstream and the local patch retired, and this is where "retired" gets recorded. Second,
**a sales artefact**: it is concrete evidence that building ConQuest on Sunrise made the
_platform_ better, not just the app.

Be honest about scale: this list is **smaller than originally planned**, because
Sunrise's own **v0.0.1 fork-readiness pass** (see
[`CHANGELOG.md`](../../../CHANGELOG.md) §`[0.0.1]`) closed most of the pre-fork backlog
before ConQuest's build began. What remains are the gaps ConQuest's _own_ build
surfaced and drove to resolution — a real, if modest, contribution.

## Record

| ID   | What ConQuest contributed                                                                                                                                                                        | Sunrise issue → PR                                                                       | In version                 | Fork benefit                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UG-1 | App-extensible drift-probe registrar — `lib/db/drift-probes.ts` (probe types + merge) and the app hook `lib/app/db-drift.ts` / `registerAppDriftProbes()`, merged by `scripts/db/check-drift.ts` | [sunrise#284](https://github.com/human-centric-engineering/sunrise/issues/284) → PR #286 | v0.0.1 (pulled 2026-06-01) | Apps register their own Prisma-unmodelled DB objects (hand-written FK constraints, custom indexes) without forking the platform drift script; CI probes them alongside the platform's |
| UG-2 | Pin the `AiConversation` unique-index name with `map:` so Prisma's derived name matches the deployed constraint                                                                                  | [sunrise#283](https://github.com/human-centric-engineering/sunrise/issues/283) → PR #285 | v0.0.1 (pulled 2026-06-01) | No phantom `ALTER INDEX … RENAME` to hand-strip from every `migrate dev` run; `ON CONFLICT ON CONSTRAINT` keeps relying on a stable name                                              |

Both gaps were surfaced by **F0.1** (schema foundations), raised and resolved upstream
on 2026-06-01, and pulled into ConQuest in the same-day sync. Full gap analysis,
proposed fix, and resolution notes live in [`upstream-gaps.md`](./upstream-gaps.md)
(UG-1, UG-2).

### Raised but not yet resolved

On **2026-06-22**, eight further gaps surfaced during the ConQuest build were raised
upstream as **UG-3 … UG-10** ([sunrise#301–#308](https://github.com/human-centric-engineering/sunrise/issues?q=label%3Aupstream-gap)):
two bug fixes (copy-timer leak #301, date-stamped model selection #302), a brand-name
seam (#305), two docs/skill gaps (`isSystem` reservation #303, marketing thin-shim
#306), and three `proposal`-tagged ideas (runtime-prompt honesty indicator #304,
structured-output enforcement #307, streaming-STT seam #308). They are tracked in
[`upstream-gaps.md`](./upstream-gaps.md) at status `raised-upstream` and **graduate to
the table above once merged and pulled down**. Note UG-6 (#304) is unlikely to be
consumed by ConQuest itself — it already solves that need app-side with its admin Prompt
Library — so it is filed as a gap for the next fork, not a carried patch.

## How an entry gets here

The loop, per [`upstream-gaps.md`](./upstream-gaps.md) and the development plan's
[Carried Sunrise patches](./development-plan.md#carried-sunrise-patches) section:

1. A generic gap is named in `upstream-gaps.md` (status `open`).
2. It's raised upstream (issue + PR); the app carries a tracked local patch meanwhile.
3. The upstream fix lands, the release is pulled down, the local patch is retired — and
   the gap is recorded here with its Sunrise PR, the version it shipped in, and the
   concrete benefit to the fork.

## See also

- [`upstream-gaps.md`](./upstream-gaps.md) — open gaps (the before-state of this ledger).
- [`../../../CUSTOMIZATION.md`](../../../CUSTOMIZATION.md) — the fix-in-place /
  promote-upstream model.
- [`../questionnaire/forking.md`](../questionnaire/forking.md) § "Contribute generic
  fixes back" — the same loop, framed for an inheriting fork.
- [`../../../CHANGELOG.md`](../../../CHANGELOG.md) §`[0.0.1]` — Sunrise's fork-readiness
  pass that closed the pre-fork backlog.
