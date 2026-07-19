# Design-time evaluation (F5.1–F5.3)

Before a questionnaire is launched, is its **structure** any good? F5.1 stands up a
panel of seven LLM **judges** that read a version's authored design — its goal,
audience, sections, and questions — and score it across distinct dimensions, each
emitting **actionable findings** (concrete proposed edits). F5.2 **persists** those runs
and surfaces run history in the admin; F5.3 turns the findings into a review queue
(accept / decline / edit / apply).

Unlike the P4 conversational engine there is no respondent and no session — the judges
grade an artefact that already exists. F5.1 shipped the judges, the dispatch capability,
and a **no-persistence preview route**. F5.2 adds the run + finding models and a
**persisting run route** built on the same dispatch seam (see [F5.2 below](#f52--persisted-runs)).

## The seven dimensions

| Dimension        | Judge slug                               | Scores                                                                                     |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `clarity`        | `app-questionnaire-judge-clarity`        | Unambiguous, single-barrelled, right reading level                                         |
| `coverage`       | `app-questionnaire-judge-coverage`       | The goal is fully covered — flags **gaps** (what's missing)                                |
| `duplicates`     | `app-questionnaire-judge-duplicates`     | Questions are distinct — flags redundancy                                                  |
| `type_fit`       | `app-questionnaire-judge-type-fit`       | Each question's answer type suits what it asks                                             |
| `ordering`       | `app-questionnaire-judge-ordering`       | Logical flow; sensitive questions placed considerately                                     |
| `audience_match` | `app-questionnaire-judge-audience-match` | Register / burden / assumptions fit the stated audience                                    |
| `goal_match`     | `app-questionnaire-judge-goal-match`     | Every question earns its place — flags **off-mission** questions (the inverse of coverage) |

The dimension → slug/label/summary registry is the single source of truth in
`lib/app/questionnaire/evaluation/dimensions.ts`, shared by the seed, the prompt
builder, and the route.

## Architecture: app-native dispatch, not the eval worker

The judges are dispatched **app-natively** — one structured `runStructuredCompletion`
call per dimension via the `evaluate-structure` capability — exactly like F4.2–F4.5,
**not** through Sunrise's dataset-driven `AiEvaluationRun` worker. That worker grades a
_subject's generated output over a dataset of cases_; here the artefact already exists
and the judges must emit _suggestions_, not a bare 0–1 score. (The plan's original F5.2
sketch named `AiEvaluationRun`; this is a deliberate divergence — see the development-plan
decisions log.)

The judges are still seeded as `kind = 'judge'` agents so they appear in the platform
Judges surface and reuse the agent resolver / cost / admin-edit machinery — but their
**rubric lives in code** (`evaluation/judge-prompt.ts`), not in the agent row, the same
split F4.5's completion agent uses. Tuning a judge is a reviewed, git-diffable code
change; the seeded `systemInstructions` are a self-describing mirror only.

## The pieces

Pure core — `lib/app/questionnaire/evaluation/` (Prisma-free, the F4 discipline):

- `types.ts` — `EVALUATION_DIMENSIONS`, `FINDING_SEVERITIES`, `JudgeFinding`,
  `JudgeVerdict`, and the `VersionStructureInput` DTO the judges read.
- `dimensions.ts` — the dimension registry (`EVALUATION_DIMENSION_SPECS`,
  `EVALUATION_JUDGE_SLUGS`, `dimensionForSlug`).
- `judge-schema.ts` — the Zod output contract (`validateJudgeVerdict`,
  `judgeVerdictJsonSchema`, `MAX_FINDINGS_PER_JUDGE`). `dimension` is **not** in the
  contract — the caller stamps it so a judge can't mislabel its own verdict.
- `structure-schema.ts` — the Zod shape of `VersionStructureInput`, shared by the
  capability (its `structure` arg) and the route loader (validates the stored audience
  JSON via `parseAudienceShape`).
- `judge-prompt.ts` — per-dimension rubrics (focus + anchored 0–1 scale + explicit
  IGNORE clause) + the structure serialiser + the retry message.

Capability — `lib/app/questionnaire/capabilities/evaluate-structure.ts`. A
`BaseCapability` running one judge for one dimension: resolve the judge's binding
(`reasoning` tier) → build the prompt → `runStructuredCompletion` (parse → retry-once →
cost-sum) → stamp the dimension → return the `JudgeVerdict`. `processesPii = false`
(goal/audience/questions are admin-authored content, not respondent data). Registered in
`lib/app/capabilities.ts`.

Route — `POST /api/v1/app/questionnaires/:id/versions/:vid/evaluate-preview`. Loads the
version structure (`_lib/evaluation-structure.ts`), loads the requested judge agents in
one query, and **fans out concurrently**, one dispatch per dimension.

```
POST …/evaluate-preview
  body: { dimensions?: EvaluationDimension[] }   // default: all seven
  → { results: [{ dimension, verdict?, diagnostic? }],
      summary: { dimensionsRequested, dimensionsRun, dimensionsFailed, totalFindings } }
```

## Findings contract

Each judge returns `{ score: 0–1, findings: JudgeFinding[] }`. A finding addresses its
target by `targetKey`: a question's stable `key`, `section:<title>`, or the literal
`goal` / `audience`. A clean dimension yields an **empty** findings array — a valid,
useful result. `severity` is `info | minor | major`. These findings are what F5.3's
review queue will become; `targetKey` is a free string reconciled fail-cleanly at apply
time (the pure core has no live graph), the F2.3 revert-planner posture.

## Gating & limits

- Always on — no flag to check. The route is admin-only paid LLM work, gated only by auth
  and the rate-limit cap below.
- Per-admin sub-cap `designEvaluationLimiter` (20 runs/min): one run is seven judge
  calls, the most expensive questionnaire sub-flow per request.
- **Fail-soft per judge**: a dimension whose judge errors or is unseeded returns a
  `diagnostic` instead of a verdict; the other six still return. Only _zero_ judges
  seeded is a 404 (`run db:seed`).

## Seeds

- `018-design-evaluation-judges.ts` — the seven `kind='judge'` agents (`isSystem: false`,
  app-owned, `restricted` KB, `internal` visibility, `temperature 0.2`), via a registry
  loop. Re-seed re-asserts only `kind`/`isSystem` (never clobbers operator edits).
- `020-design-evaluation-capability.ts` — the `app_evaluate_structure` `AiCapability`
  row. **Not** bound to any one agent — it's dispatched against a different judge each
  call, so there is no `aiAgentCapability` row.

F5.1 added no schema; the run + finding tables arrive in F5.2's
`app_questionnaire_evaluation_run` migration.

## F5.2 — persisted runs

F5.2 turns the ephemeral preview into a **persisted, synchronous run** and gives the admin
a run history. Deliberately **synchronous** — the POST runs the panel inline (the same
`Promise.all` fan-out) and writes the result before returning; there is **no worker and no
polling**. (Async was considered and rejected: the codebase has no background-task
registration seam, so a worker would force editing the platform-owned maintenance tick — a
layering inversion — for no payoff over the proven synchronous seam. `status` is a plain
String holding a terminal value, so a future worker could add `running`/`queued` with no
migration.)

Shared dispatch — `lib/app/questionnaire/evaluation/run-panel.ts`. The F5.1 fan-out was
extracted into `runEvaluationPanel(...)` (Prisma-free: agents + structure passed in,
returns `{ results, summary }`, fail-soft per judge). Both the preview route and the new
run route call it; the preview returns it ephemerally, the run route persists it.

Models (`prisma/schema/app-questionnaire.prisma`):

- `AppQuestionnaireEvaluationRun` — the run header. Terminal `status` (`completed` |
  `partial` | `failed`), the `dimensionsRequested/Run/Failed` tallies, `totalFindings`, and
  a `dimensionSummary` **JSON** array (`[{ dimension, score?, findingCount, diagnostic? }]`
  — a fixed ≤7-entry summary read wholesale by the UI, so no per-dimension table).
  `triggeredByUserId` is a plain String (the UG-1 deferred-User-FK posture); `questionnaireId`
  is denormalised for questionnaire-scoped listing. FK to the version `ON DELETE CASCADE`.
- `AppQuestionnaireEvaluationFinding` — **one row per judge finding** (not a JSON blob),
  because F5.3's review queue mutates findings individually. Persists the `JudgeFinding`
  contract verbatim plus the stamping `dimension`, an `ordinal`, and a minimal review
  `status` (default `pending`) **added now** so F5.3 extends rows rather than running a
  second migration. FK to the run `ON DELETE CASCADE`.

Persistence + reads — `_lib/evaluation-run-routes.ts` (the DB seam; the pure core stays
Prisma-free). `persistEvaluationRun` derives the status (`failed` if no judge ran, `partial`
if some failed, else `completed`), flattens verdicts into ordinal-stable finding rows, and
writes both in one `$transaction`. `dimensionSummary` is Zod-validated on read (the
`parseAudienceShape` posture), degrading a malformed blob to `[]`.

Routes (under `…/versions/:vid/evaluations`):

```
POST …/evaluations                 → run the panel, persist, return the run detail
  body: { dimensions?: EvaluationDimension[] }   // default: all seven
GET  …/evaluations                 → run headers, newest-first, paginated
GET  …/evaluations/:runId          → one run with its findings (version-scoped)
```

The **POST** is paid LLM work, so it keeps the F5.1 gating verbatim: the
`designEvaluationLimiter` 429 (reused — same seven-call cost), version-scope 404, and a
not-configured 404 when zero judges are seeded. The two **GETs are read-only**:
version-scope only (the `changes`-list posture).

Admin UI (`app/admin/questionnaires/[id]/v/[vid]/evaluations/**`): the **Evaluations**
workspace tab with a "Run evaluation" button, and a read-only run-detail page
(`…/evaluations/[runId]`) grouping findings by dimension. The version is the `[vid]` path
segment (the shared workspace selector switches it). No accept/decline yet — that's F5.3.

## F5.3 — suggestion review

F5.3 turns the persisted findings into a **review queue**: the admin works through each judge
suggestion and accepts, declines, edits, or **applies** it to the draft version — forking a
launched version first, exactly like every authoring edit.

### Structured edits — the accelerator

The quality ceiling is whether a suggestion arrives _already actionable_. So F5.3 went back into
the F5.1 findings contract: alongside the prose `proposedChange`, a judge may attach a structured
**`proposedEdit`** — a discriminated union on `op` keyed to the same `targetKey` addressing:

| `op`              | Target            | Dimensions             | Apply effect                                  |
| ----------------- | ----------------- | ---------------------- | --------------------------------------------- |
| `replace_prompt`  | slot `key`        | clarity                | rewrite the prompt                            |
| `edit_guidelines` | slot `key`        | clarity, audience      | set/clear author guidelines                   |
| `change_type`     | slot `key`        | type_fit               | change answer type (config revalidated/reset) |
| `delete_question` | slot `key`        | duplicates, goal_match | remove the question                           |
| `reorder`         | slot `key`        | ordering               | move to a 0-based ordinal (± section)         |
| `edit_goal`       | `goal`            | goal_match             | replace the version goal                      |
| `edit_audience`   | `audience`        | audience_match         | merge-patch the named audience sub-fields     |
| `add_question`    | `goal`/`section:` | coverage               | create the drafted question (or refine first) |

The op is an **accelerator, never a trust boundary**: it is prompt-guided, _not_
provider-enforced (the JSON schema is never sent to the model — `runStructuredCompletion` is plain
prompt + Zod parse). So it is optional (a nuanced finding stays prose-only), soft-degraded to
`null` on malform at persist (`coerceProposedEdit`, the `parseAudienceShape` posture), and
**re-validated at apply time exactly like a hand authoring edit**. There is intentionally no
`merge` op — duplicates emit `delete_question` on the weaker slot.

### Apply — reuse the fork-if-launched seam

`_lib/evaluation-apply.ts` (`applyFinding`) executes `editedOverride ?? proposedEdit` through the
**same leaf helpers** the F2.1 routes use (`validateTypeConfig`, `forkVersionIfLaunched`, the
provenance stamps) rather than the HTTP handlers — the load-bearing validation is shared; only the
`targetKey`→entity resolution is apply-specific. The order matters:

1. prose-only (no op) → `needs_authoring` (the UI deep-links the editor — there's nothing to
   blind-apply).
2. `add_question` → `applyAddQuestion` (see below) — it creates a slot rather than editing one, so
   it has its own path.
3. **Apply-time staleness re-check** (optimistic concurrency) — reject if the structure drifted.
4. Resolve the editable version: if a prior apply from this run already forked (or edited) a live
   draft, **reuse it** — repeated applies converge on one draft instead of re-forking the launched
   original each time (the fork-lineage rule). Otherwise validate the op against the original
   _before_ forking (no orphan drafts), then `forkVersionIfLaunched`.
5. Retarget the slot on the editable version (keys copy 1:1 across a fork), execute the op + stamp
   the finding `applied` (`appliedAt`, `appliedToVersionId`) in one transaction.

**`add_question` apply (`applyAddQuestion`)** — unlike the in-place ops the judge's draft carries no
ids, so the path is: validate (and default) the drafted `typeConfig` — a choice/scale type the judge
left bare falls back to `defaultTypeConfig`, landing placeholder options the admin refines after;
resolve the target **section by title** (`op.sectionKey`, else the finding's `section:<title>`, else
the last section — fork-stable, so it survives a fork), failing `target_gone`/`op_invalid` for a
gone/ambiguous title and `needs_authoring` only when the version has no sections at all; derive the
`key` from the judge's optional concise `key` (slugified) falling back to the prompt, collision-
suffixed against the version's keys; then create the slot + stamp the finding applied in one
transaction. Same fork-lineage convergence as the in-place ops.

The judge is prompted to attach a concise `snake_case` `key` and to pick a `type` that fits the
answer (free_text for open-ended, likert only for fixed scales, etc.) rather than defaulting to
likert. Independently, the shared key deriver (`slugifyKey`) now drops grammatical stopwords and
keeps the first few content words, so **every** key path — extraction, hand-authoring, data slots,
this apply — yields concise keys (`describe_current_morale_work`, not the whole sentence) instead of
a slugified sentence.

An unapplicable apply returns **409** with a reason the UI acts on: `stale` (re-run),
`target_gone` (deleted), `op_invalid` (e.g. incompatible type config), `needs_authoring`.

### "Open in editor" — the refine path

The one-click apply lands the drafted question as-is; when the wording (or a choice list) needs work
first, the card's secondary **"Open in editor"** deep-links the structure editor with
`?edit=1&seedFinding=<runId>:<findingId>`. The structure page resolves that ref
(`getEvaluationAddQuestionSeed`) into an `EvaluationSeed` and renders
a highlighted, pre-filled `EvaluationSeedComposer` at the top of the editor. The admin tweaks
prompt/type/section/guidelines and clicks "Add to questionnaire": the question is created through the
ordinary authoring route (forking a launched version like any edit), then the finding is stamped via
`PATCH … { action: 'mark_applied', appliedToVersionId }` — a review action that records the terminal
state + the (possibly forked) draft it landed in **without** mutating structure itself (the editor
already did the authoring). The editor then navigates to that draft with the seed cleared.

### Staleness — derived, never stored

`status` holds `pending | accepted | declined | applied`. **`stale` is not a status** — it is
derived at read time (`_lib/evaluation-staleness.ts`) by diffing the **targeted slice** of the
run's `structureSnapshot` (the `VersionStructureInput` captured when the judges ran) against the
live structure. Only the specific thing a finding addresses is compared, so an unrelated edit never
falsely stales it; `delete_question` is stale only if the slot is already gone. A pre-F5.3 run with
no snapshot reads as not-stale (best-effort). For a launched (frozen) version the snapshot always
equals the live structure, so staleness is meaningful only for drafts — which is exactly where the
structure mutates under the findings.

### Target resolution — which question a judgement is about

`targetKey` is the right _machine_ handle (stable across reordering, what apply reconciles
against) but a useless _label_: a card reading "`q_role` · Rewrite the question prompt" forces the
reviewer into the structure editor to find out what is being judged. So the read seam resolves the
key to its subject — `_lib/evaluation-target.ts` (`resolveFindingTarget`) projects a `target`
onto each finding view: `{ kind, key, label, sectionTitle, position, removed }`, where `label` is
the question's prompt (or the section title, or "Questionnaire goal" / "Target audience").

Same posture as staleness — **derived at read time, never stored** (a persisted prompt would rot
the moment the question was reworded) — with two differences worth knowing:

- Resolution prefers the **live** structure and falls back to the run's `structureSnapshot`, so a
  question deleted since the run is still named, flagged `removed: true`, rather than showing a
  bare key.
- It is resolved for **terminal** findings too (staleness is not): an applied finding must still
  say which question it changed.

An unresolvable key (a judge occasionally invents one) degrades to `kind: 'unknown'` with the key
as its label — the card renders, the raw-key chip still identifies it, fail-cleanly like apply.

### Models, routes, UI

- Columns added (additive, nullable migration): `AppQuestionnaireEvaluationFinding.proposedEdit`,
  `editedOverride`, `decidedByUserId`, `decidedAt`, `appliedAt`, `appliedToVersionId`; and
  `AppQuestionnaireEvaluationRun.structureSnapshot`. The detail GET is now staleness-aware (no new
  read endpoint).
- `PATCH …/evaluations/:runId/findings/:findingId` — accept / decline / edit / `mark_applied`
  (`applied` is terminal → 409). `mark_applied` validates `appliedToVersionId`
  belongs to this questionnaire and records the terminal state for the editor refine path — it does
  **not** mutate structure. `POST …/findings/:findingId/apply` — apply
  (`evaluationApplyLimiter` 60/min; may fork; handles `add_question` too). Accept is triage, **not**
  apply — kept distinct so an admin can agree across a run, then apply against one consistent fork
  lineage.
- The run-detail admin component is the interactive queue. Each card names its subject first —
  a context chip ("Question 2 · Background", "Goal") and the question prompt quoted beneath the
  badges, from the resolved `target` — then leads with the **primary
  work-action** sized by the effective op — **"Add to questionnaire"** for an `add_question`
  (one-click apply) plus a secondary **"Open in editor"** (the seeded refine deep-link); **"Apply"**
  (with an inline edit-override mini-form for text ops + type + ordinal) for other structured ops;
  **"Open in editor"** for prose-only — with **Accept / Dismiss** kept as quiet secondary triage so
  the work-action is never mistaken for "do it". Plus a status filter and a fork banner pointing at
  the new draft when an apply forks a launched version.
- `EvaluationSeedComposer` (`components/admin/questionnaires/`) renders the pre-filled new-question
  form for the "Open in editor" deep-link; the structure page resolves the seed and forces edit mode.

## Reading a run — two views over the same findings

The API returns findings ordered by `(dimension, ordinal)`: the order they were **produced**. That
is the right shape for "how did the Clarity judge do?" and the wrong shape for the job the admin is
on the page to do — fix the questionnaire. A question flagged by three judges is the strongest
signal a run carries, and in dimension order those three findings sit screens apart. So the
run-detail page offers two groupings over one set of findings and one set of review actions:

| View            | Grouping                    | Answers                                                    |
| --------------- | --------------------------- | ---------------------------------------------------------- |
| **By question** | one card per `target.key`   | "what's wrong with Q4, and do the judges agree?" (default) |
| By judge        | one section per `dimension` | "which dimension is unhappy, and what did it score?"       |

By-question sorts three ways — `natural` (questionnaire order), `major` (worst-first), `findings`
(busiest-first) — via the pure `groupFindingsByTarget` in
`components/admin/questionnaires/evaluation-grouping.ts`. Both count sorts fall back to natural
order, so equally-severe targets stay in a stable, meaningful sequence. Each card leads with the
question prompt (the subject under review), names the judges that flagged it, and tallies severity;
`FindingReviewCard` takes a `lead` prop that swaps its leading chip from the target to the judge,
since under a question heading the missing fact is _which judge said this_.

**Every group starts collapsed.** The page opens as a scannable index — which questions have
problems, how many judges agree, and how severe — and the reviewer drills into the ones they choose
to work on. That is why the card header has to carry its weight on its own: context chip, the
prompt, the judge-consensus row, and the severity tally are all visible closed. Groups open
independently and stay open across a re-sort (the card is keyed on the target, not its sorted
slot), so re-ordering never folds away work in progress.

**Only flagged targets appear.** The payload carries findings, not the version's question list, so
a clean question is absent by construction — the headline says "across N flagged items" rather than
implying full coverage. Non-question targets (`section`, `goal`, `audience`, `unknown`) get their
own groups; nothing is filtered out, and `goal`/`audience` pin above the structure.

### Headline band

`EvaluationRunHeadline` puts the two questions an admin opens the page with above the fold: severity
totals + review progress (`CqStatTiles`), and a per-judge strip carrying each dimension's score and
its severity split. **Judge cells are filter buttons** — the summary is a way into the work, not
decoration. When judges failed, the band says the totals are an undercount rather than quietly
omitting them; a stale count is surfaced the same way.

Three filters compose across both views (status ∧ severity ∧ judge). **Severity filtering is new**:
`severity` was previously display-only, which made "show me what blocks launch" — the entire point
of the `major` level — impossible to ask.

### `sectionPosition` — the one read-seam addition

`position` is 1-based _within a section_, so it cannot order questions across sections. The by-question
natural sort needs a section ordinal, so `FindingTargetView` gained **`sectionPosition`**, populated
by `resolveFindingTarget` from a `sectionIndex` now returned by `locateSlot`. Same posture as the
rest of the view: **derived at read time, never stored**, no migration. It is `null` for
`goal`/`audience`/`unknown`, and falls back to the run snapshot for a since-removed section so
history still orders sensibly.
