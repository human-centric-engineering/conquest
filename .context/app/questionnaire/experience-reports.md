# Experience reports

Reports over an experience come in two shapes, and they answer different questions.

| Report          | Subject                                     | Status                   |
| --------------- | ------------------------------------------- | ------------------------ |
| **Step report** | everyone who answered ONE step of a journey | shipped (F15.4a)         |
| **Run report**  | ONE respondent across all their legs        | shipped (F15.4b)         |
| Experience-wide | a synthesis over ready step reports         | not planned as one phase |

The two are orthogonal: a step report is _cross-respondent, one questionnaire_; a run report is
_one respondent, cross-questionnaire_.

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

## The run report (F15.4b)

One summary for a whole journey — what `conclude` has promised since F15.2.

**The pipeline is reused, not forked.** `generateReportFromInputs` takes pre-assembled material, so
`run-report.ts` only assembles inputs from N legs; KB grounding, web-search rounds, the agent, the
formatter, the appendix pass and the method record all apply unchanged.

**A leg generates no per-session report.** The run report covers every leg — generating both would
bill the journey twice and hand the respondent n+1 reports where one was promised. The submit route
skips the enqueue for a leg, failing soft to "not a leg" (a redundant report beats none).

**Enqueued from `concludeRun`** — the single choke point where a journey is known to be over, so
every dead end (selector, budget, no candidates, unrunnable step) still yields a report.

Anchoring choices, all for the same reason — a run spans several versions, so something must
arbitrate:

| Input    | Comes from           | Why not the alternative                                          |
| -------- | -------------------- | ---------------------------------------------------------------- |
| settings | the **entry** leg    | the last leg varies by routing → same experience, different look |
| KB scope | the **experience**   | a leg's questionnaire would be arbitrary                         |
| goal     | the **entry** leg    | later legs' goals show in their own headed sections              |
| coverage | **summed** over legs | the final leg alone overstates how much was answered             |

**Per-leg `## Part N — <title>` headings are load-bearing.** Without them the writer reads a flat
wall of Q&A and cannot see the respondent was asked about a topic twice, in two questionnaires —
the progression a journey report exists to notice.

`runId` is a **real** cascading relation (a run is respondent data, not config — UG-1 forbids
CONFIG→answer edges, and the run is the answer side). `sessionId` relaxed to nullable-unique;
`subjectKind` discriminates.

The respondent view composes the entry leg's chrome with the run's generation state, and suppresses
the method panel — the base view resolves the entry leg's record, which no longer exists.

### Known erasure gap (pre-existing)

`eraseUser()` removes the profile snapshot but retains sessions, answers, transcripts and reports —
`respondentUserId` is a plain String with no FK and no erasure hook is registered.
`AppRespondentProfileSnapshot` is the one app table with a modelled `User` FK. Structured answers
are arguably de-identified by that; **free-text transcripts and report prose are not**. F15.4b
follows the existing pattern rather than half-fixing it; closing this is its own work with a real
retain-vs-delete decision inside it.

## Related

- `.context/app/planning/features/f15.4a.md` — per-step reports, what shipped and why
- `.context/app/planning/features/f15.4b.md` — the run report, what shipped and why
- `.context/app/questionnaire/experiences.md` — the model
- `.context/app/questionnaire/experience-continuity.md` — the respondent journey
- `.context/app/planning/features/f15-followups.md` — everything still open across P15

## The experience-wide synthesis (F15.8)

`/admin/experiences/[id]/reports` renders it above the per-step tabs. Code:
`lib/app/questionnaire/experiences/synthesis/**`. Schema: `AppExperienceSynthesis`.

**It reads finished outputs, never sessions.** This is the whole design constraint, and the reason
the earlier note in this doc said an experience-wide view "must be a synthesis over ready step
reports, not a re-aggregation". `buildCohortDataset` resolves everything by a single `versionId`
and `buildDataSlots` joins fills by `dataSlotId` — the row id, not the key — so a fill from another
version finds no bucket and is dropped with **no error and no warning**. An experience spans
versions by definition, so the obvious implementation would emit a confident, well-formatted report
over a fraction of the data. `synthesis.test.ts` asserts the module never imports the dataset
builder and never touches `appAnswerSlot` / `appDataSlotFill` / `appQuestionnaireSession`.

**The two kinds read different things**, because they produce different things:

| kind                  | input                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `agentic_switcher`    | ready per-step cohort reports, plus the routing distribution             |
| `facilitated_meeting` | `AppExperienceInsight` rows, re-gated at the current `insightMinSupport` |

The meeting gate is re-applied **on read** rather than trusted from write time, so raising
`insightMinSupport` after a meeting immediately narrows what any later synthesis can see. Anything
below the floor never enters the material, so the writer cannot surface it, paraphrase it, or fold
it into a finding — anonymity carries through by construction rather than by instruction.

**Two fields the model does not write.** `coverage` is server-computed from the material: a model
asked to describe its own inputs produces a tidy answer, and coverage is exactly the field a reader
leans on to judge how far to trust the rest. Citations (`sourceStepKeys`) are verified against the
steps that actually contributed and unknown keys are dropped — the same evidence-not-conclusion
discipline `verifiedSupportCount` applies to breakout support counts. A hallucinated citation is
worse than none: it sends a reader to check a source that never said it, and makes an unsupported
claim look sourced. The prompt does not mention the check; a prompt is not where this is enforced.

**Partial by design.** Missing or unfinished step reports are recorded in coverage and skipped
rather than blocking generation — one never-generated step would otherwise hold the whole feature
hostage. Generating with nothing ready returns 409 `NOTHING_TO_SYNTHESISE` with the coverage
attached, so the panel can name the missing steps instead of saying "something went wrong".

**A shape-valid answer is not a usable one.** The response schema puts no floor on `narrative` or
the claim arrays, so `{"narrative":"","findings":[],"divergences":[]}` parses cleanly. The parse
callback therefore also requires `isUsableSynthesisContent`, which is what earns the retry and then
the hard failure — without it a degenerate answer is stored `ready` and the admin pays for a call
that renders as a coverage list with nothing above it and no error. Note the asymmetry it encodes:
a narrative with no findings is legitimate (every step agreeing is a real result), a wholly empty
one is not.

**Spend is logged through `logAppLlmCost`**, like every other app-tier LLM call. The `costUsd` on
the row is display-only and is overwritten on every regeneration, so it is not an aggregate — the
`AiCostLog` row is what makes the synthesiser agent's `monthlyBudgetUsd` ceiling able to fire at
all, since `checkBudget` aggregates by `agentId`. `versionId` is null: an experience spans versions
by definition.

**No revision chain**, unlike `AppCohortReport`. A synthesis reads a moving target — its inputs are
themselves regenerated and edited — so a history would imply a stability it does not have. One row
per experience, replaced on regeneration. A failed regeneration preserves the previous content:
retrying should never be worse than not trying.

**Its own table, not a fourth `ReportScope` kind.** `AppCohortReport.versionId` is NOT NULL on every
row because each of its scopes analyses exactly one version, and `scopeOwnerCreate` /
`scopeOwnerWhere` are deliberately exhaustive switches. An experience has no single version to put
there.
