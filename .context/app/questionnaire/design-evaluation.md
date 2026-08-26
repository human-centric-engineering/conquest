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

**Judges lead with the alternative, not the complaint.** The prompt requires `proposedChange` to _be_
the fix wherever one is feasible — the rewritten question, the better type, the position to move to —
and reserves diagnosis-only findings for cases where proposing one would mean inventing facts the
judge cannot see (a policy, a definition, what the author meant); the judge then says what it would
need, in `rationale`. `proposedEdit` follows the same posture: **prefer** attaching the structured op
(it is what makes a suggestion one-click applicable) rather than the older "attach only when
confident of every field", which read as a discouragement and left applicable fixes stranded as prose
the admin had to retype. The guard that survives the softening is the one that matters — never invent
a key, section title, or type that is not in the structure.

This changes the two **delete-first** dimensions most. Duplicates now prefers salvaging a partial
overlap (`replace_prompt` narrowing the weaker question to the part the other misses) over removing
it, and Goal-Match prefers a refocus over a deletion where the question can be pointed back at the
goal. Both keep `delete_question` for the genuinely redundant and the genuinely off-mission — the
change is which one they reach for first.

## Cross-judge reconciliation — the step after the panel

The panel's independence is the source of its credibility and the source of its most annoying
output. Every judge scores blind to the others, so a question that four of them flag comes back with
four rewrites, each fixing one dimension and quietly undoing another: apply the Clarity judge's
wording and the jargon the Audience judge objected to can come back; apply the Audience judge's and
the double-barrel returns. Nothing in the panel can fix that, because no judge is allowed to see
another's verdict.

So one more agent runs after the fan-in. The **Suggestion Reconciler**
(`app-questionnaire-suggestion-reconciler` → `app_reconcile_suggestions`) takes the questions **more
than one judge flagged** and proposes one or two phrasings that satisfy as many of their concerns as
possible at once.

| Aspect         | Choice                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| What it reads  | The contested questions, their current wording, every judge verdict, plus goal/audience |
| What it writes | Nothing — a proposer, like the judges; the admin accepts, edits, or ignores             |
| Batching       | ONE call for the whole run, not one per question                                        |
| Scope          | Question targets only, 2+ **judges** (not 2+ findings), capped at 15 most-contested     |
| Persistence    | `reconciledSuggestions` (nullable JSON) on the run row                                  |
| When it runs   | Persisted runs only, and only if the judges left wall-clock for it (below)              |

**Why "more than one judge" and not "more than one finding".** One judge raising two points about a
question is still one perspective, and reconciling a perspective with itself proposes nothing worth
paying for.

**Why the preview does not reconcile.** `runEvaluationPanel` takes an explicit `reconcile: boolean`
— required, not defaulted, so a new caller has to decide rather than inherit. The run route passes
`true`; the preview route passes `false`, because it returns `{ results, summary }` ephemerally and
has nowhere to put the alternatives. Billing an extra reasoning call for a payload that is dropped
on the way out is not a cheaper preview, it is a more expensive one.

**Why it can be skipped on a slow run.** The step is serial: it starts after the fan-in. A judge
costs up to `JUDGE_TIMEOUT_MS` and `runStructuredCompletion` gives its one retry a _fresh_ timeout,
so the concurrent fan-out is 180s at worst; reconciliation is another 180s on the same arithmetic.
360s overruns the routes' `maxDuration = 300`, and a function killed there throws away seven judge
calls the admin has already paid for. So `runEvaluationPanel` checks the clock before it starts:
under `PANEL_BUDGET_MS` (285s, leaving a reserve for the structure build and the run's persistence)
it needs `RECONCILE_TIMEOUT_MS × 2` still unspent, or it logs a warning and stands down. Skipping
degrades to exactly what a failed reconcile degrades to — the judges' own suggestions — which is
what every surface showed before this step existed. Raising the ceiling was not an option: 300 is
already the highest `maxDuration` in the codebase.

**Why question targets only.** Findings against the `goal`, the `audience`, or a section are not
phrasings to rewrite. This also excludes the Coverage judge's drafted new questions, which are
addressed at `goal` by convention — a question that does not exist yet cannot be rephrased.

**Why the cap logs.** Fifteen is a bound on cost and on one shared token budget, and targets go in
most-contested-first (major findings, then judge count, then position — so the batch is reproducible
run to run). When more questions were contested than fit, `runEvaluationPanel` logs how many were
left out. A silent cap is the dangerous version: an admin reading 15 reconciled questions would take
the other 5 for questions the panel was happy with.

**`addresses` and `unresolved` are the honest half of the contract.** Each alternative names the
dimensions it genuinely resolves, and `unresolved` names concerns no wording can fix — nearly always
because the real fix is structural (split the question, change its answer type), which this step is
not allowed to make. A reconciliation that silently dropped a judge's point would be worse than none
at all: it would read as consensus that was never reached.

**Fail-soft in the strong sense.** Nothing contested, no reconciler agent seeded, a failed dispatch,
a thrown fault, or a success payload of the wrong shape — every one returns `[]` and the run
completes with all seven judges' own suggestions intact. An admin who has just paid for seven judge
calls must not lose them because an eighth failed. Legacy runs, written before the column existed,
read as `null` → `[]` via `parseReconciledSuggestions`: not missing data to backfill, but a true
statement that the run was never reconciled.

The alternatives reach the [Questionnaire Pack](./questionnaire-pack.md) through
`EvaluationRunDetail.reconciled`, rendered under the question they belong to with dimension keys
mapped to judge labels — and the run-detail page reads the same field (below).

### The verdict band — what the reviewer sees first

A by-question card leads with the **verb**, not the evidence: reword / move / delete / change the
answer type, derived from the findings' effective ops by the pure `summariseGroupActions`
(`evaluation/group-actions.ts`), followed by the reconciled wording and only then — on expand — the
individual judgements. The page used to open at the evidence and leave the reviewer to infer the
verb by reading four suggestions per question.

Three rules hold it honest:

- **Never manufacture a consensus.** The primary action is the one with the most judges behind it;
  every dissenting action is printed beside it ("· 1 judge says delete this question instead"). The
  reviewer is arbitrating, and needs both halves to do it.
- **Ties break by consequence, not by order.** One judge saying delete and one saying reword surfaces
  the deletion. Not because it is likelier to be right, but because it is the harder change to undo
  and a collapsed card must never hide it.
- **The verb follows `editedOverride ?? proposedEdit`** — what apply actually runs. A header reading
  "Reword it" above a button that deletes the question would be lying about its own control.

The backing count's denominator is the judges that **flagged this question**, not the seven on the
panel: the other five had nothing to say about it, and counting them as absent votes would read as
weaker support than the panel actually gave. Who flagged it at all is answered by the judge chips
once the card is open.

**One card open at a time.** These cards are tall when open (several finding cards, each with its own
apply controls), so two at once means scrolling past finished work to reach unfinished work. The
accordion also matches how the reviewing goes: fix one, move to the next.

### Reading it: a column, a header band, an indent, and two faces

The page is a queue of prose decisions, and it was drowning in its own text. Four fixes, all in
service of one thing — the reviewer being able to tell, at any scroll position, _which question am I
looking at_ and _whose words are these_.

**A capped, left-aligned reading column.** The admin shell is full-bleed, which suits a table and
not this page: on a wide monitor an uncapped column ran lines past 200 characters, where the eye
loses the start of the next line on the return sweep. The run page caps itself at `max-w-5xl` and
paragraph blocks cap again at `PROSE_MEASURE` (68ch), because a card also holds badges and buttons
that legitimately want the extra width. Left-aligned rather than centred: the workspace chrome
directly above (title, status, tab bar) is itself full-bleed and left-aligned, and a centred column
visibly detaches from it at 2560px.

**One filled surface per group, and everything about it is indented.** The group used to be a
bordered card holding a tinted header holding a tinted verdict panel holding bordered finding
cards — four nested frames, which reads as clutter and flattens the hierarchy the frames were meant
to express. Now the disclosure band is the only thing filled; the group itself has no border, the
verdict hangs off a hairline rule in its action tone rather than sitting in a tinted panel, and the
whole body steps in from the left edge. With the frames gone, the indent and the space between
groups (`space-y-8` — generous, not tidy) are what carry the structure. Finding cards keep their
border: they are a list of discrete items each with its own apply controls, and at the deepest level
that boundary is information rather than decoration.

**Weight is not one of the signals.** The question and the proposed wordings are set at regular
weight. They already carry a face change, a size step, and (for the heading) a filled band behind
them; adding bold on top made a page of long questions heavier to read rather than easier. The one
thing still bold is the verdict's verb — two words, and the only anchor the eye needs per group.

**Two faces, one rule: the questionnaire's own words are set in the ConQuest display serif**
(`QUESTION_FACE` in `evaluation-field.tsx`). That covers the card heading, the reconciled wording, a
drafted new question, the evidence quote, and — via `QuotedProse` — any span a judge put in quotes
inside a sentence. On the run this was built against, 27 of 40 suggestions were of the shape "Add a
direct question on runway, such as: “If your main income stopped tomorrow…”", where the wording
being proposed was buried mid-sentence in the same face as the advice around it; it now changes face
and slants, and can be found without reading the sentence carrying it.

Two constraints on that:

- **It marks what the text says about itself.** `QuotedProse` restyles quoted spans only. It never
  guesses that an unquoted sentence "looks like a question" and restyles the whole of it — that
  would misattribute a judge's own advice to the questionnaire, which is the exact confusion the
  treatment exists to prevent.
- **Never the only signal.** Block-level question text keeps its curly quotes, and inline spans
  render as `<q>` so the quotation marks come back from the UA stylesheet. A font swap is invisible
  to a screen reader and to anyone whose webfont failed to load.

## Gating & limits

- Always on — no flag to check. The route is admin-only paid LLM work, gated only by auth
  and the rate-limit cap below.
- Per-admin sub-cap `designEvaluationLimiter` (20 runs/min): one run is seven judge
  calls, the most expensive questionnaire sub-flow per request.
- **Fail-soft per judge**: a dimension whose judge errors or is unseeded returns a
  `diagnostic` instead of a verdict; the other six still return. Only _zero_ judges
  seeded is a 404 (`run db:seed`).
- **Per-judge budget**: `JUDGE_MAX_TOKENS` 8,192 output tokens, `JUDGE_TIMEOUT_MS` 90s,
  and `maxDuration = 300` on both panel routes (the judges fan out concurrently, so the
  request costs one slow judge, not seven — 180s of one, since the retry gets a fresh
  timeout). Size the token cap for Clarity, not the
  average: it attaches a full rewritten prompt to every finding, and on OpenAI's
  reasoning families (`o*`, `gpt-5*`) the cap is sent as `max_completion_tokens`, so
  hidden reasoning tokens come out of the same budget. At the original 2,048 the Clarity
  judge was cut off mid-JSON on real questionnaires.
- **Reading a judge failure**: a truncated response and a contract violation both end as
  `evaluation_failed`, but they need opposite fixes, so the capability distinguishes them.
  `parseableJson: false` in the error log (message says _"not parseable JSON … most likely
  truncated"_) means the budget ran out — raise `JUDGE_MAX_TOKENS`. `parseableJson: true`
  with populated `issuePaths` means the model broke the contract at those fields — a
  prompt or schema problem. An empty `issuePaths` alone tells you nothing; read the flag.

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
returns `{ results, summary, reconciled }`, fail-soft per judge). Both the preview route and
the new run route call it; the preview returns it ephemerally (and passes `reconcile: false`),
the run route persists it.

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
POST …/evaluations/:runId/retry    → re-run ONE failed judge into that run
  body: { dimension: EvaluationDimension }
```

The **POST** is paid LLM work, so it keeps the F5.1 gating verbatim: the
`designEvaluationLimiter` 429 (reused — same seven-call cost), version-scope 404, and a
not-configured 404 when zero judges are seeded. The two **GETs are read-only**:
version-scope only (the `changes`-list posture).

### Retrying one failed judge

Fail-soft means a run can persist with a hole in it: six verdicts and one diagnostic, and severity
totals that are therefore an **undercount**. The fix is not "run the panel again" — that pays for
six needless judge calls and, worse, produces a _second_ run, stranding every accept/decline/apply
decision already recorded against the first. So `POST …/:runId/retry` re-dispatches the one judge
and merges the outcome back into the same run (`mergeJudgeRetry`):

- that dimension's summary entry is **replaced**, its finding rows deleted and rewritten (a retry
  can never double up), and the run's `dimensionsRun` / `dimensionsFailed` / `totalFindings` /
  `status` / `error` are re-derived from the patched summary — via the same `statusFromCounts` the
  initial persist uses. `dimensionsRequested` never moves: the panel that was asked for is a fact
  about the run. `completedAt` is re-stamped, because the run genuinely gained work.
- the judge reads the run's **`structureSnapshot`**, not the live structure. A run is a verdict on
  one structure; mixing in a judgement of a newer draft would make the per-finding staleness
  derivation (which diffs snapshot vs live) meaningless. Only a pre-F5.3 run without a snapshot
  falls back to the live structure.
- a retry that fails again merges the **fresh** diagnostic and leaves the run `partial` — the
  undercount warning stays true rather than silently keeping a stale reason.
- the summary is re-read **inside the transaction, under a `FOR UPDATE` lock on the run row** —
  never reused from the snapshot `loadRunForJudgeRetry` took before the judge call. That call takes
  seconds, so two admins retrying two _different_ failed judges on one run would otherwise both
  patch the same stale array and the second write would erase the first: the run would report a
  judge as failed while its finding rows sat in the table, and the UI would offer a Retry whose
  `deleteMany` destroyed them. Same posture, same reason, as the dataset-case PATCH route.

Gating: the same `designEvaluationLimiter` sub-cap (a hammered retry button is exactly the spend
that cap exists to bound), version+questionnaire-scope 404, 404 when the dimension was not part of
the run or its judge is unseeded, and **409** when the judge already returned a verdict — its
findings may carry review decisions, and deleting those to make room for a fresh opinion is not
this route's call. Re-run the panel for that.

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

| `op`              | Target            | Dimensions             | Apply effect                                         |
| ----------------- | ----------------- | ---------------------- | ---------------------------------------------------- |
| `replace_prompt`  | slot `key`        | clarity                | rewrite the prompt                                   |
| `split_question`  | slot `key`        | clarity                | one question becomes two (target keeps its identity) |
| `edit_guidelines` | slot `key`        | clarity, audience      | set/clear author guidelines                          |
| `change_type`     | slot `key`        | type_fit               | change answer type (config revalidated/reset)        |
| `delete_question` | slot `key`        | duplicates, goal_match | remove the question                                  |
| `reorder`         | slot `key`        | ordering               | move to a 0-based ordinal (± section)                |
| `edit_goal`       | `goal`            | goal_match             | replace the version goal                             |
| `edit_audience`   | `audience`        | audience_match         | merge-patch the named audience sub-fields            |
| `add_question`    | `goal`/`section:` | coverage               | create the drafted question (or refine first)        |

The op is an **accelerator, never a trust boundary**: it is prompt-guided, _not_
provider-enforced (the JSON schema is never sent to the model — `runStructuredCompletion` is plain
prompt + Zod parse). So it is optional (a nuanced finding stays prose-only), soft-degraded to
`null` on malform at persist (`coerceProposedEdit`, the `parseAudienceShape` posture), and
**re-validated at apply time exactly like a hand authoring edit**. There is intentionally no
`merge` op — duplicates emit `delete_question` on the weaker slot.

### `split_question` — closing a gap the Clarity judge already had

The Clarity judge was always instructed to propose splits it had no way to express. Its rubric
scores questions on being "single-barrelled"; its prompt gives _"Split into: 'What is your role?'
and 'How long have you been in it?'"_ as the model example of a good finding; and
`reconcile-prompt.ts` listed splitting among the fixes **no wording can deliver**. Every such
finding therefore landed prose-only, and the admin retyped it in the Structure editor.

Unlike `merge`, split has a clean write path, so it earns an op:

- **The target keeps its identity** — same id, key, type, config, ordinal — and takes the first
  half. That is what makes it safe on a version with answers already against it: nothing that
  referenced the slot stops resolving, and the second half is purely additive. Writing both halves
  as two new slots would orphan every existing answer.
- **The new sibling is inserted directly after**, shifting the rest of the section down one.
  Adjacency is part of the contract: two halves separated by six unrelated questions read worse
  than the compound they replaced, so the `add_question` convention of appending to the end of the
  section is deliberately not reused here.
- **Type, config, `required`, `weight` and `fidelity` are inherited**, not defaulted — a compound
  question's two halves almost always want the same answer type, and an author who set a fidelity
  stop meant it for both asks. Guidelines are inherited for the reason the extractor keeps
  ambiguous spans: duplicated guidance is visible and deletable, dropped guidance is not.

**This op is why ingest stopped splitting.** The extractor used to be told "split a compound
question into separate ones", and doing it silently made the same document extract to a different
question count on different runs — routing-corpus doc 02 produced 22, 28, 23, 28, 28 and 28
questions across six ingests of one 22-question file, and two ingests that disagree on the count
cannot be compared in a cohort. The edit is a good one; it just needs an author's eye, which is
what this panel is. Ingest is now faithful and the judge proposes the split.

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
onto each finding view: `{ kind, key, label, sectionTitle, position, sectionPosition, questionType,
removed }`, where `label` is the question's prompt (or the section title, or "Questionnaire goal" /
"Target audience") and `questionType` is the configured answer type (`null` for non-question
targets). The type travels with the target because a suggestion reads differently depending on it —
"add a scale anchor" is meaningless on free text — and the alternative is a trip to the structure
editor. It stays a `string`, not a `QuestionType`: it comes from a stored structure that may name a
type this build no longer knows, and the UI (`questionTypeLabel`) falls back to the raw value.

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
  badges with its answer type, from the resolved `target` — then leads with the **primary
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
`lib/app/questionnaire/evaluation/group-findings.ts`. It lives in `lib/` rather than beside the
components because the **Questionnaire Pack export shares it**: the pack groups its evaluation
appendix by question for the same reason this page defaults to it, and a printed document has no
toggle to fall back on. Two copies of "what counts as one subject" (the gap-group split especially)
would drift. Both count sorts fall back to natural
order, so equally-severe targets stay in a stable, meaningful sequence. Each card leads with the
question prompt (the subject under review), names the judges that flagged it, and tallies severity;
`FindingReviewCard` takes a `lead` prop that swaps its leading chip from the target to the judge,
since under a question heading the missing fact is _which judge said this_.

**Every group starts collapsed.** The page opens as a scannable index — which questions have
problems, how many judges agree, and how severe — and the reviewer drills into the ones they choose
to work on. That is why the card header has to carry its weight on its own: context chip, the
prompt, its answer type, the judge-consensus row, and the severity tally are all visible closed. Groups open
independently and stay open across a re-sort (the card is keyed on the target, not its sorted
slot), so re-ordering never folds away work in progress.

**Every block of prose is labelled, and the questionnaire is separated from the advice.** A finding
card stacks three or four paragraphs — the question under review, the judge's suggestion, its
rationale, sometimes a quote — and with only font weight between them a reader landing mid-card
cannot tell whether a sentence is _the questionnaire_ or _the AI's opinion of it_, which is the one
distinction the page exists to communicate. So the card is two bands: a tinted, ruled-off **header**
carrying the badges and (under a judge heading) the question itself, and a **body** in which every
block is introduced by a small uppercase eyebrow — `Suggestion`, `Rationale`, `Evidence`, `Edit`,
`Suggested new question · <type>`. Below the rule, everything is the judge talking.

The eyebrow is `FieldLabel` / `LabelledField` from
`components/admin/questionnaires/evaluation-field.tsx`, shared rather than re-declared per file: the
value is in the labels being visibly the same kind of thing everywhere, and the moment two surfaces
drift in size or weight the eyebrow stops reading as structure and starts reading as decoration. The
by-question group header uses the same `FieldLabel` for its context chip.

The header's named-target block renders **only for `question` and `section` targets**, whose label is
real content. `goal` / `audience` / `unknown` labels merely restate the kind, which the badge-row
context chip already carries — a block would print the same word twice under an eyebrow saying it a
third time. When the block does render, its eyebrow carries the _full_ context ("Question 4 ·
Business Execution") and the badge-row chip is dropped, so the target is named once, not twice.

**A quote that only restates the prompt is dropped.** Judges routinely cite the question's own
wording as their `sourceQuote`, which is useful in the raw payload and noise on screen: the prompt
is already the card's heading (by question) or its target line (by judge), so re-rendering the same
sentence indented beneath the rationale reads as a further detail that isn't one.
`quoteRestatesTarget` suppresses a quote that matches the target label after normalisation, in
either containment direction. A quote reaching outside the prompt — guidelines, a neighbouring
question, an answer option — survives, because that is evidence found nowhere else on the card.

**Only flagged targets appear.** The payload carries findings, not the version's question list, so
a clean question is absent by construction — the headline says "across N flagged items" rather than
implying full coverage. Non-question targets (`section`, `goal`, `audience`, `unknown`) get their
own groups; nothing is filtered out, and `goal`/`audience` pin above the structure.

**Coverage gaps group by op, not by target — the one exception to keying on `target.key`.** A gap is
a question that does not exist yet, so it has no key to be addressed at; the Coverage judge is told
to hang it on the literal `goal` (see the ops table above). Grouped by target that files drafted
questions under a heading reading "Questionnaire goal", which states the opposite of what they are —
not an edit to the goal statement, but coverage the goal implies and no question supplies. So any
finding whose **effective op** (`editedOverride ?? proposedEdit`) is `add_question` is routed to a
single synthetic group, `gap:new-questions`, titled _"Questions not yet asked"_ and captioned as
proposed additions. It sorts after `goal`/`audience` and before the structure, carries no answer type
(each draft names its own), and leaves genuine `edit_goal` findings under the goal where they belong.
Editing a draft into an in-place op moves it back out of the gap group, since the effective op is
what actually applies.

Two labels on the finding card follow from the same confusion. The drafted prompt is captioned
**"Suggested new question · &lt;type&gt;"** — it renders in the same weight as `proposedChange`
directly above it, so unlabelled a question that doesn't exist reads as one that does. And the
data-slot checkbox names its subject (_"Also add the new question to a data slot"_): its bare form
read as slotting the group heading rather than the question being drafted.

### Headline band

`EvaluationRunHeadline` puts the two questions an admin opens the page with above the fold: severity
totals + review progress (`CqStatTiles`), and a per-judge strip carrying each dimension's score and
its severity split. **Judge cells are filter buttons** — the summary is a way into the work, not
decoration.

**A failed judge is styled as a failure, and carries its own way out.** The first cut admitted the
undercount honestly but quietly — a dashed, 70%-opacity cell with an outline `failed` chip, and a
grey 11px footnote — which reads as _less important_ when it means _a column of this summary is
missing_. Now: the tally splits into "6/7 ran" plus a destructive "1 failed", the cell is tinted
rather than faded and carries a warning icon, the stored diagnostic **code** is translated into a
sentence an admin can act on (`judgeFailureReason`, in `evaluation-judge-failure.tsx`; the raw code
stays on the `title` for support), the undercount note is a ruled destructive row, and both the
headline cell and the by-judge section offer **Retry judge** — the only action that actually fixes
the undercount. `EvaluationRunDetail` owns the fetch and holds the run in state, swapping in the
refreshed detail wholesale; the review statuses it returns are the persisted ones, so nothing local
is lost. Stale counts stay a muted footnote — a stale finding is information, not a hole.

**The severity bar's ramp is measured, not chosen by eye.** Fills come from `--cq-sev-major` /
`-minor` / `-info` in `globals.css` — hot red → warm amber → neutral grey, so severity reads as
falling chroma. The first cut used `bg-destructive` and `--cq-accent`, which failed twice: the burnt
amber accent measures **ΔE 10.0** from the destructive red (below the 15 normal-vision floor), so
the two stacked segments read as one red band — and because the accent is the _darker_ of the pair,
minor looked more severe than major, inverting the ordinal signal. The replacement measures ΔE 24.1
normal / 19.2 deutan / 18.2 tritan on light, 27.4 / 20.4 / 24.5 on dark, whose steps are selected
against the dark surface rather than flipped from light. Segments carry a 2px gap so adjacent fills
never touch. Colour is never the sole signal — each bar pairs with a text tally and an `aria-label`.
Re-measure with the `dataviz` skill's `validate_palette.js` before touching these values.

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
