# Experience reports

Reports over an experience come in two shapes, and they answer different questions.

| Report          | Subject                                     | Status                   |
| --------------- | ------------------------------------------- | ------------------------ |
| **Step report** | everyone who answered ONE step of a journey | shipped (F15.4a)         |
| **Run report**  | ONE respondent across all their legs        | F15.4b                   |
| Experience-wide | a synthesis over ready step reports         | not planned as one phase |

## Step reports are scoped PER STEP — never per experience

This is the constraint the whole design hangs off, and it is a data-correctness rule, not a
simplification.

`buildCohortDataset` resolves questions, data slots, profile fields and the scoring schema by a
**single `versionId`**. `buildDataSlots` joins fills by `dataSlotId` — the row id, not the key — so
a fill belonging to a session of a different version finds no bucket and is **silently dropped**
(`if (!bucket) continue`). `chart-series.ts` makes the same assumption for question ids.

An experience spans several questionnaire versions by definition. A cross-step scope would
therefore emit a confident, well-formatted report over a fraction of the data, with no error and no
warning — worse than refusing.

A step pins exactly one version, so a step scope carries one `versionId` and the entire pipeline
(dataset → digest → agent → revision → publish → PDF) works unchanged. **Five modules needed zero
changes.** If an experience-wide view is ever built, it must be a synthesis over ready step
reports, not a re-aggregation.

## The session pointer

`AppQuestionnaireSession.experienceStepId` — plain String, indexed, no FK (UG-1), written once by
`createSessionForExperienceLeg`.

Denormalised from `AppExperienceRunLeg.stepId` because that table's `sessionId` is itself an
unmodelled pointer: there is no relation to join through, and `scopeSessionWhere` is pure and
returns a plain Prisma `where`. The alternatives were carrying resolved `sessionIds[]` in the scope
(goes stale, breaks purity, thousands of ids in a query on a large cohort) or making
`scopeSessionWhere` async (breaks the client-safe contract it documents).

**Filtering on `versionId` alone is not equivalent.** It sweeps in every ordinary round and walk-up
session on the same questionnaire and reports them as part of the journey. A test pins this.

`stepId` is a **required** parameter of `createSessionForExperienceLeg` — optional would let a
caller silently mint a leg no step report can ever see.

## The third owner key

`AppCohortReport` was already polymorphic (`round` | `version`). F15.4a adds
`experienceStepOwnerId` as a third nullable-unique owner column. Postgres permits multiple NULLs in
a unique index, which is the only reason three "one report per owner" constraints coexist on one
table.

`scopeOwnerCreate` uses an **exhaustive switch**: adding a fourth scope kind must fail to compile,
not silently write a row with every owner key null and collide with the next one.

`versionId` is set on **every** row whatever the owner — it is the analysed subject.

## Which version a step reports on

`resolveStepVersionId` (`experiences/_lib/steps.ts`) — the step's pin, else the questionnaire's
newest launched, unarchived version.

Shared with the run advance path deliberately. That path asks "which version does the next leg
run?" and the report asks "which version did these legs run?". If those disagree, the report
resolves its data slots against the wrong vocabulary and analyses nothing.

## The opt-in gate

The step's **version's own** `config.cohortReport.enabled` — the same switch the round and
version-wide reports AND.

Deliberately not a new experience-level setting: an author who turned reporting off for a
questionnaire has not consented to it being generated because that questionnaire happened to be
reached through a journey.

## Surfaces

Routes: `/api/v1/app/experiences/:id/steps/:stepId/cohort-report` plus `/dataset`, `/generate`,
`/generate/stream`, `/revisions`, `/publish`, `/export.pdf` — thin mirrors of the version-scoped
set, differing only in the scope they resolve.

Admin: the experience workspace **Reports** tab, with a step selector reusing `CohortReportPanel`
via `stepReportApi`. Its own tab rather than a section under Runs because a run is one
respondent's journey and a report is every respondent who answered one step.

## Gotchas

**Both F15.4a migrations needed hand-stripping — for three reasons, not one.** The five pgvector
indexes; the raw-SQL PARTIAL UNIQUE INDEX on `app_questionnaire_session`; and
`ai_knowledge_chunk.searchVector`, which is `GENERATED ALWAYS` and which Prisma reads as a default
it wants to drop. The schema test asserts all of this for both migrations.

**`column_default IS NOT NULL` is a false alarm on a generated column.** Postgres reports
`column_default` as NULL for `GENERATED ALWAYS`; the expression lives in `generation_expression`.

**Mirrored routes compile while carrying wrong copy.** The seven step routes were derived
mechanically from the version ones and arrived with "version scope" headers and "No version report"
error strings. Type-checking cannot catch that — read the output.

## Related

- `.context/app/planning/features/f15.4a.md` — what shipped and why
- `.context/app/questionnaire/experiences.md` — the model
- `.context/app/questionnaire/experience-continuity.md` — the respondent journey
