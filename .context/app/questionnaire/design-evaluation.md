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

Three of the seven read one more thing when the questionnaire uses Conditional Topics — see
[What the judges see when routing is on](#what-the-judges-see-when-routing-is-on).

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

Duplicates has a second reason to prefer narrowing, when routing is on: the weaker question may be
one of only a handful in a conditional topic, and removing it can leave that topic with too little to
ask. Where the topic is `light`, the apply engine refuses the delete outright rather than relying on
the judge to have been persuaded — see below.

## What the judges see when routing is on

**F17.34.** ConQuest runs three design-time judge panels, and until F17.34 only two of them read
Conditional Topics: the scope panel (F17.21) and the policy panel (F18) both carry topic membership,
and this one carried none at all.

That mattered most to **Duplicates**. It read one flat numbered list in which an `opening`
signal-gathering question and a `conditional` depth probe sat side by side, unmarked — and its rubric
told it to flag pairs that ask substantially the same thing across sections and to target the later
one, which is always the probe, with a one-click `delete_question`.

Backwards, and the product had already written down why. From
[`conditional-topics.md`](./conditional-topics.md) and F17.33: the opening exists to make a
respondent talk broadly, and the planner seats topics **because of what they said**, so the overlap
between the two is the selection criterion rather than redundancy.

Ordering and Goal-Match were wrong for the same reason — one read phase transitions as sequence
defects, the other read narrow role-specific probes as off-mission because it could not know they
only run for that role. And worse than any single finding: a panel score was **not comparable**
between a topics-enabled and a topics-disabled version of the same instrument.

### The overlay

`VersionStructureInput` carries an optional `routing` block (the topic roster, the per-interview cap,
and a pre-counted conditional-question total) and each question an optional `topicKeys`.

**Absence is the flag.** With Conditional Topics off — the default, and most questionnaires — there
is no `routing` block, no annotations, and the prompt is byte-identical to its pre-F17.34 form. A
test pins that for every dimension. An empty `topicKeys` is a different thing and is meaningful:
routing is on and nothing claims this question, so it can never be asked.

Three smaller shapes, each with a failure behind them:

- **`topicKeys` is an array.** Multi-membership is legal (a `duplicate_membership` warning, not a
  prevention), and a question in both a `core` and a `conditional` topic is asked of everyone.
  Collapsing to one owner would let the co-occurrence rule _downgrade a real duplicate_.
- **`phase` and `depth` are `string`, not the enums.** This DTO is persisted verbatim as a run's
  `structureSnapshot`, and `parseStructureSnapshot` degrades the whole snapshot to `null` on any
  parse failure — silently disabling staleness for that run. A `z.enum` would turn one renamed phase
  into total loss across every historical run.
- **Loaded on the existing `findFirst`**, through the version's own `config` and `topics` relations.
  `evaluation-batch-apply` calls `buildEvaluationStructure` once per finding, so separate queries
  would land on every finding in a batch.

### The rule, and where the attention is spent

Only three dimensions gain a paragraph, and only when routing is configured. An earlier draft keyed a
rule on every pair of the four phases — a sixteen-cell truth table written as prose, which a model
collapses to whichever rule it read first. What survives is one principle and the two consequences
that are not already the status quo:

> **CO-OCCURRENCE.** Two questions are only duplicates if the SAME respondent is asked both.
>
> - The opening is deliberately the broad version of what the depth topics probe later. Never
>   propose `delete_question` for it, keep the finding at `info`, and do not let it lower the score.
> - Two questions in different "asked-when-it-fits" topics may never both be asked — say so, and drop
>   the severity a level.
> - Everything else is a duplicate exactly as it would be without routing.

The scale gains a line saying deliberate opening→depth overlap does not lower the score. Without it a
judge told to stay quiet still marks down, and the score is what an admin compares across versions.

**The rest of the attention is bought in the structure block, where it is cheap.** Each question is
annotated in the same plain words the rule uses (`topic=talent/asked-when-it-fits`) so the judge never
holds a translation in mind; a question in no topic says outright that it is never asked; and the
ROUTING frame states the proportion as well as the rule, because a judge told "2 of 5 questions are
conditional" calibrates severity far better than one handed a rule alone. The per-interview cap is
mentioned only where it can actually bind.

Clarity, Coverage, Type-Fit and Audience-Match are untouched — they judge things routing does not
change — and a test asserts their prompts are byte-identical with and without the overlay.

### On the review card

`FindingTargetView` carries `routingReach` (`always` / `conditional` / `never` / `null`) and
`topicLabel`, rendered as a chip beside the answer type: "Always asked · Spine", "Asked when it fits ·
Talent depth", "Never asked — in no topic".

It reports **reach, not phase**: a question in several topics is asked of everyone if any of them
always runs, and reporting one topic's phase would label such a question "conditional" and invite the
delete this whole feature exists to prevent.

And it is gated on `routing.enabled`, **never** on "the version has topics" — ingest seeds one `core`
topic per section on every questionnaire, so a presence test would chip every finding card in the
product and teach reviewers to ignore it.

### Applying a finding keeps membership true

**F17.35.** Three ops change the question set, and all three used to leave topic membership stale —
which, with routing on, means a question that can never be asked, or a topic that resolves to nothing
while every coherence check reports it as fine. See [`f17.35.md`](../planning/features/f17.35.md);
the short version:

- `split_question` copies the parent's membership onto the new half.
- `add_question` inherits from its section-mates (the `planDataSlotAttachment` majority rule), and
  reports `newQuestionTopicKey: null` when nothing could be inferred — which the outcome panel names,
  because "applied" otherwise reads as "and it will be asked".
- `delete_question` prunes the key from every topic, and is **refused** (`topic_sample_too_small`)
  when its target sits in a `light` topic that would fall below `LIGHT_DEPTH_MEMBER_COUNT`. That
  guard is code rather than rubric: the judge cannot see depth or member counts, and the apply engine
  already treats every op as an accelerator rather than a trust boundary.

The review queue also shows a banner when routing is on and the live structure has uncovered
questions, using the same `uncoveredQuestionKeys` count the Topics tab shows.

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

### Three layers: the question, the verdict, one judge

A by-question group is read in three steps, and the reviewer chooses when to take each one.

**Closed** is an index entry: the question, its answer type, its severity tally, and — when the panel
split — that the judges disagree. Nothing else. A verdict printed on every row of a long queue is a
paragraph the reviewer has to read past to reach the next question.

**Open** adds the panel's combined verdict, inside the _same filled header area_ as the question and
flush with it. The verdict is a property of the question above it, not a detail underneath it;
sitting in the same indented column as the individual judges, it read as the first of them rather
than the summary of all of them.

**A judge's tab** is the third step: one judge's reasoning, with its own apply controls, indented
beneath the header area. Stacked in one column, a question flagged by four judges was four
near-identical cards each carrying its own Apply button, and the reviewer scrolled past three to
reach the fourth. `JudgeTabs` makes "whose reasoning am I reading" a choice rather than a scroll
position, and keeps exactly one set of decision controls on screen.

The verdict itself is **one block per proposed action**, ruled off from its neighbours, each under a
heading naming what it is and who is behind it ("A reword, as proposed by 2 of 3 judges"). It was
one line — the winning verb with the dissent appended as a trailing clause — which is the whole
panel compressed into a sentence the reader has to unpack before knowing what the options are.
`ACTION_NOUNS` supplies the noun forms: as a heading, the imperative "Reword it" reads as an
instruction being given rather than a label for the thing described.

Four rules hold it honest:

- **Never manufacture a consensus.** Every proposed action gets its own block, in support order. The
  dissent is not a footnote on the winner; it is the next heading down.
- **Ties break by consequence, not by order.** One judge saying delete and one saying reword surfaces
  the deletion. Not because it is likelier to be right, but because it is the harder change to undo.
- **A closed card may hide the verdict, never the disagreement.** `contested` is on the closed
  header, so a reviewer skimming the queue can never discover only after opening a card that a judge
  wanted the question deleted.
- **The verb follows `editedOverride ?? proposedEdit`** — what apply actually runs. A heading reading
  "A reword" above a button that deletes the question would be lying about its own control.

The backing count's denominator is the judges that **flagged this question**, not the seven on the
panel: the other five had nothing to say about it, and counting them as absent votes would read as
weaker support than the panel actually gave.

Reconciled wordings attach to the **reword** block when there is one, and only fall back to the
leading action when there is not. They answer "reword it" and nothing else, so hanging them off
whichever action happened to win would, on a question where the deletion led, print proposed wording
under a heading reading "A deletion, as proposed by 2 judges". The `unresolved` caveat lives inside
that same block for the same reason — floating at the end of the verdict, "Type-Fit is not resolved
by rewording" read as a free-standing finding about a judge rather than as a limit on the wording
directly above it.

**One card open at a time.** These cards are tall when open (a verdict, a tab strip, a finding with
its own apply controls), so two at once means scrolling past finished work to reach unfinished work.
The accordion also matches how the reviewing goes: fix one, move to the next.

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
them; adding bold on top made a page of long questions heavier to read rather than easier. Nothing
on the page is bold: `font-medium` is the heaviest thing it uses, and it is spent on the verdict's
verb, the eyebrows, and the one-line caption saying what applying would do.

**Two faces, one rule: the questionnaire's own words are set in the ConQuest display serif**
(`QUESTION_FACE` in `evaluation-field.tsx`). That covers the card heading, the reconciled wording, a
drafted new question, the evidence quote, and — via `QuotedProse` — any span a judge put in quotes
inside a sentence. On the run this was built against, 27 of 40 suggestions were of the shape "Add a
direct question on runway, such as: “If your main income stopped tomorrow…”", where the wording
being proposed was buried mid-sentence in the same face as the advice around it; it now changes
face, and can be found without reading the sentence carrying it. Roman, not italic: the face and the
quotation marks are already two signals, and the slant was a third that landed on the longest
strings at the smallest sizes — a whole proposed question set in slanted serif is the hardest thing
on the card to read, which is exactly backwards.

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

### Where the question would go, said before it goes there

The section resolution above is three rules deep, and until F5.3's placement pass **none of it
reached the reviewer**. The card previewed the drafted prompt, its type and its guidelines, and the
sentence under the button read "Adds this as a new Free text question." A coverage gap targets
`goal`, so nothing on the finding named a section either. Accepting a suggestion therefore meant
accepting a placement nobody had seen. And when the judge named no section, "the last section" is
a placement nobody had _chosen_.

It matters more than tidiness. With [Conditional Topics](./conditional-topics.md) on, the section a
question lands in is what decides which respondents are ever asked it. The finding view already
carries `routingReach` for existing targets on exactly that reasoning; a question being added had no
equivalent.

Three parts:

1. **`resolveAddDestination`** (`_lib/evaluation-target.ts`) mirrors `applyAddQuestion`'s rules and
   returns `{ sectionTitle, sectionPosition, origin }` on the finding view, derived at read time
   against the **live** structure like `resolveFindingTarget` beside it. `origin` is the load-bearing
   field: `chosen` (someone picked it), `default` (apply will append to the last section), `none`
   (no sections exist, so apply answers `needs_authoring`). A named title that no longer resolves to
   exactly one section keeps its name and loses its position, which is the same condition
   `deriveFindingState` already reports as `stale`.

   The mirroring is the point. The card is telling a reviewer what a click is about to do, so any
   drift between the two is a lie told at the moment it matters most. Two limits on it are worth
   knowing. A structure that **could not be loaded** returns `null`, not `origin: 'none'`: the card
   renders `none` as "this questionnaire has no sections", which is a claim about the
   questionnaire, whereas a failed load is a fact about us. And `current` is always built from the
   URL's version while apply writes into the run's reused review draft once one has been forked, so
   the two can drift if someone edits sections on that draft between the read and the apply. No op
   in the set mutates sections, so they agree in practice, and the write stays safe either way
   because `validateSectionTarget` re-checks live state. The sibling `stale`/`applicable` fields
   inherit the same seam.

2. **The card says it**, in the draft block ("Goes into “Background” (section 2)" / "No section was
   suggested, so it would go at the end of “Wrap-up”") and again in `effectOf` under the button,
   which is the last thing read before the click.

   Tense follows the finding. Once it is terminal a `chosen` destination becomes "Went into
   “Background”", which stays true because `chosen` comes from the op's own `sectionKey` and that
   is the title apply resolved against. A `default` says **nothing** at all once terminal: it is
   re-derived against the structure as it is now, so it would name whichever section is last today
   rather than where the question actually went. Nothing records the real answer, and silence beats
   a confident wrong one.

3. **The reviewer can redirect it.** A `<select>` of the run's `sectionTitles` writes an
   `editedOverride` through the existing `edit` action, because an admin-edited op is already what
   takes precedence at apply. Redirecting is deliberately **not** a decision: choosing where a
   question would go is not agreeing that it should exist. The picker is hidden when there is one
   section or none, and a since-deleted destination stays selectable so the reviewer can see which
   section went missing rather than being shown a live one nobody chose.

   The redirect joins `inFlightCardWrites` (formerly the steer-only `inFlightSteerSaves`), which
   the batch bar drains through `whenCardWritesSettled()` and a decision on the card sequences
   behind. This is the steer race with a worse ending: the redirect stores the very override the
   batch reads to decide **where** to create the question, so an unregistered write let a reviewer
   who moved a question and immediately pressed "Apply accepted changes" have it created in the
   section they had just moved it out of, and then stamped applied. The steer race loses a
   sentence; this one loses the placement, and a terminal finding offers no second chance.

`sectionTitles` lives on `EvaluationRunDetail`, not on each finding: it is the same list for all of
them, and a forty-finding run should not carry forty copies of it.

**One cap, at the point of creation.** Section titles were bounded nowhere they are made (an
unbounded Postgres `String`, `min(1)` in both the ingest and authoring schemas) and capped at 200
everywhere they are referenced, which is the wrong way round: by the time a reference refuses a
title it is already persisted, and the finding naming it degrades to prose. `SECTION_TITLE_MAX`
(`questionnaire/types.ts`) now bounds it where it is created, and the judge contract derives its
caps from that. The derivation matters because a `targetKey` addressing a section is
`section:<title>`: at a flat 200 it held eight fewer characters than `sectionKey` did for the same
string, so a 195-character title was creatable, referable one way and not the other. 200 is four to
five times any real heading (the longest in this codebase is 44 characters), so it bounds
mis-extraction rather than authors.

The coverage judge's prompt was also changed from `"<existing section title, optional>"` to an
instruction to **always** set `sectionKey` when the questionnaire has sections, and it is told the
consequence of omitting it (the silent append to the last section) rather than just the rule. The
judge has just read the whole structure, so it is the reader best placed to say where a gap belongs.

The judge is prompted to attach a concise `snake_case` `key` and to pick a `type` that fits the
answer (free_text for open-ended, likert only for fixed scales, etc.) rather than defaulting to
likert. Independently, the shared key deriver (`slugifyKey`) now drops grammatical stopwords and
keeps the first few content words, so **every** key path — extraction, hand-authoring, data slots,
this apply — yields concise keys (`describe_current_morale_work`, not the whole sentence) instead of
a slugified sentence.

An unapplicable apply returns **409** with a reason the UI acts on: `stale` (re-run),
`target_gone` (deleted), `op_invalid` (e.g. incompatible type config), `needs_authoring`. The
per-finding route is API-only as of F5.4 — the review surface writes exclusively through the batch
(below), which reports the same reasons per finding in its result rather than as an HTTP error.

## F5.4 — triage the run, then apply it as a batch

Per-finding apply was the only path, and it made the reviewer decide the **order** of a dozen
structural edits by the order they happened to click, one confirmation at a time, with no way to
change their mind about the fifth after seeing the ninth. It also put four verbs on every card —
accept, dismiss, edit, apply — two of which are English near-synonyms that do very different things.

The flow is now triage-then-execute. Reviewing writes nothing structural: an admin works the whole
run marking suggestions **Accept** or **Dismiss**, optionally attaching a free-text steer to any of
them, and then presses one button that executes every accepted suggestion together. A queue of
irreversible clicks becomes one reviewable decision.

### The reviewer's steer — `applyInstruction`

A nullable column on the finding, and the only new state the feature adds. It is the reviewer's own
words about how to make the change ("keep it under 15 words, don't mention tenure") — never parsed
into an op here, just carried. `null` means "apply the structured op exactly as the judge proposed
it", so **the AI leg is opt-in per finding, by the admin typing something**; a run where nobody
types anything applies exactly as deterministically as it did before, and reaches no provider at
all.

It replaced the typed `editedOverride` form on the card, which asked the reviewer to pick an exact
op when what they actually wanted to express was a preference. The `edit` action stays in
`reviewFindingSchema` and apply still honours stored overrides — the capability is API-accessible,
it is just no longer a control. `set_instruction` writes the steer **without touching `status`**: a
reviewer may note what they want before deciding whether they want it, and losing that on the way to
a decision is the kind of small betrayal that stops people using the box at all. Bounded at
`MAX_APPLY_INSTRUCTION` (2 000) because it is replayed verbatim into an LLM prompt; an emptied box
normalises to `null` so "cleared it" and "never typed anything" are one state.

### The batch — a loop with an order and an honest report

`POST …/evaluations/:runId/apply` → `_lib/evaluation-batch-apply.ts`. The writing is still
`applyFinding`, unchanged: same re-validation, same fork-lineage rule, same 409 reasons. Reusing it
is the point — a batch must not be a second apply path with its own validation, or the two drift and
one of them is the one with the hole. Three things the loop adds:

**An execution order that does not sabotage itself** (`APPLY_RANK`). The reviewer accepted a _set_,
not a sequence, so the batch has to choose one, and the naive choice (the order the judges emitted
them) loses work for nothing. Two cases decide the ranking:

- **A delete runs last.** Accept "reword Q4" and "delete Q4" — a real outcome, since two judges can
  disagree and a reviewer can agree with both in the moment. Deleting first makes the reword
  `target_gone`; rewording first makes the delete a clean no-loss. Same end state; only one order
  reports it without an error.
- **A move runs after content edits.** `reorder` carries an absolute ordinal computed against the
  structure the judge saw. Content edits do not shift ordinals but another move does, so moves
  cluster at the end where they shift a stable base.

Ties fall back to `(dimension, ordinal, id)` — a total order, so the same accepted set always
executes the same way rather than shuffling between presses.

**A live re-read between findings.** `applyFinding` takes the current structure to re-check
staleness against, and in a batch that structure is a moving target: the third finding must be
judged against what the first two just wrote. Without it, two judges rewording the same question
would both "succeed" and the second would silently overwrite the first. Once a fork has happened the
re-read follows it — judging the batch's own work against a version it is no longer editing would
find no drift at all.

**A per-finding outcome.** Nothing is swallowed: every accepted finding comes back applied, or
skipped with a reason (`stale`, `target_gone`, `op_invalid`, `needs_authoring`, `needs_ai`,
`steer_unsupported`). A batch
that quietly drops three of eleven changes is worse than no batch, so the route **always returns
200** when the run resolves — "every accepted change was already stale" is an answer the reviewer
needs the detail of, and an error envelope would throw that detail away. The response also carries
every finding re-derived, so the queue re-renders from one round trip.

### The surface — a queue you triage, and one bar that executes it

Three places carry the state, and between them they answer "what have I decided" and "has any of it
happened" without the reviewer having to ask:

**The card** offers exactly two verbs, and neither reaches the questionnaire. The sentence over
them is future-tense on purpose — "Accepting queues this change. Applying the run then removes this
question from the questionnaire" — because a card that promised a click did something would be the
same lie the old per-finding Apply told, moved one step earlier. Once accepted, the card says
outright that it is **not applied yet**: someone who accepts twenty suggestions and walks away must
not believe the questionnaire changed.

**The header tiles** count Accepted and Dismissed apart rather than rolling them into one
"reviewed" figure, which answered neither of the two questions a reviewer is actually tracking —
how much is queued to apply, and how much did I throw away. The Accepted tile's hint carries the
warning too ("queued — not applied yet"), because a count of accepted suggestions is exactly where
someone would assume the work was done.

**The batch bar** is a permanent band, not a toast on each Accept. Being told twenty times through
a dialog that accepting changes nothing teaches a reviewer to dismiss the dialog without reading;
a count that sits there saying "6 accepted changes, not applied yet" is unmissable and never in the
way. It reports from the whole run and never the filtered view — a bar reading "3 accepted" while
eleven were about to be applied would be worse than no bar at all.

Pressing apply with the queue half-triaged raises a confirmation, not a block: "do the ones I have
looked at" is a legitimate thing to want, so the dialog states what will and will not happen
(`N still have no decision. Applying now writes the M you accepted and leaves the rest alone`) and
lets it through. Afterwards the result panel stays on screen until the next batch, because it is
the **only** place a change that did not land is ever named. Each skipped finding is given a reason
in the reviewer's terms — `stale` becomes "the question changed since this evaluation ran" — and
noted as _still accepted_, so fixing the cause and pressing apply again picks it up without
re-triaging. Applied changes link straight to the new version in Build.

The instruction box sits behind a link rather than on every card: most findings are accepted as
proposed, and forty textareas is noise that makes the two decisions harder to reach. It saves on
blur via `set_instruction`, and `accept` carries anything still unsaved as a belt to that braces.
Its in-flight state is tracked **apart from** the decision buttons' — clicking Accept blurs the
box, which starts the save, and a shared busy flag disabled the button in the instant between the
blur and the click landing on it, swallowing the very click that caused the save.

### Versioning — fork only when needed

Unchanged, and deliberately so: the batch inherits it from `applyFinding` rather than reimplementing
it. A launched version is deep-copied to a fresh draft before the first write; an editable draft is
written in place; and a second batch from the same run converges on the draft the first one made
(`findRunReviewDraft`). So repeated batches do not pile up versions, and the draft is the one thing
the reviewer opens in Build afterwards.

### The AI leg — the reviewer's steer, executed

A finding carrying an `applyInstruction` cannot be executed by its structured op alone: the steer
has to reach the wording. So before a single write happens, every steered finding goes through the
**Suggestion Steer** agent (`app-questionnaire-suggestion-steer`,
`lib/app/questionnaire/evaluation/steer-edit.ts`) — one structured completion each, rewriting that
change's text to follow the reviewer's sentence.

It is deliberately **not** routed through the Structure Edit Agent, which the F5.4 notes originally
proposed. That agent's op vocabulary (`set_required`, `transform_prompt`, `move_question`…) is
whole-document and mechanical; it cannot express `split_question`, `change_type`, `edit_guidelines`
or `add_question` at all, and its persona is explicitly "never rewrite wording unless told to". Two
opposite mandates on one binding would have meant a parallel op vocabulary anyway, so the steer got
its own agent and its own prompt.

**The model never touches the data.** Three things enforce that, and they are structural rather than
prompt-shaped:

- **It can only return text.** `steeredEditSchema` has one member per steerable op carrying only
  that op's free-text fields. There is no field for a slot key, an answer type, a section, an
  ordinal or a `typeConfig` — a model that decides the question should really be moved has no way to
  say so.
- **The op kind cannot change.** `mergeSteeredEdit` refuses a revision whose `op` differs from the
  judge's and rebuilds the op from the original for every field the model was not offered. The
  reviewer accepted "split this question"; they get a split, worded their way, keeping the judge's
  `secondKey`. This is the one outright refusal in the leg — an op switch is the model overruling
  the reviewer's own decision.
- **It re-enters the ordinary apply path.** The rewritten op rides in as `editedOverride`, so
  `applyFinding` validates it exactly as it validates an admin's typed override: same slot check,
  same staleness re-check, same fork rule. The AI leg is a rewriter sitting in front of apply, not a
  second way in.

**Three ops carry no wording** (`delete_question`, `reorder`, `change_type`), so an instruction on
one has nothing to act on. Those are reported as `steer_unsupported` without a model call, because
asking a model to reword a deletion is nonsense and applying it with the reviewer's sentence
dropped is the silent-substitution failure this leg exists to prevent. For the same reason a steer
that _fails_ (no provider, a failed call, an op switch) is reported as `needs_ai` and the judge's
own op is **not** applied as a consolation: the reviewer asked for their version of the change, and
quietly giving them a different one under the same button is worse than a skip. The finding stays
`accepted` either way.

**Honesty about what did not land.** The result carries `note` (what the instruction changed, in one
line) and `unhonoured` (the part of it wording alone could not satisfy — an answer type, a scale, an
ordering), and the result panel shows both next to the applied change. A steer that only partly
landed has to be visible at the moment it lands, or the reviewer reads "applied" as "all of it
applied" and finds the gap later, in the questionnaire.

**Cost and shape.** Steers run concurrently (`STEER_CONCURRENCY = 4`) before the ordered apply loop,
not inside it: a rewrite depends only on the change and the questionnaire as the reviewer saw it,
not on what the other findings wrote, and eight sequential model calls would time the batch out. A
run where nobody typed an instruction makes **no** model call and does not even read the structure
an extra time — the deterministic path is exactly as cheap as it was. Every attempt is recorded as
an `AppAiRun` of kind `evaluation_steer`, failures included, because this is the one place in the
evaluation flow where a model's own words reach the questionnaire.

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
problems, how severe, and whether the panel agreed — and the reviewer drills into the ones they
choose to work on. Closed, a card carries its context line, the prompt, its answer type, the
severity tally and the disagreement marker; the verdict and the judges are both a click away. Groups
stay open across a re-sort (the card is keyed on the target, not its sorted slot), so re-ordering
never folds away work in progress.

**Two verbs, and they are opposites.** There used to be four — accept, dismiss, edit, apply — split
by _position_ alone (decision-recording left, questionnaire-changing right) with the detail in
tooltips. That failed for the obvious reason: a reviewer deciding whether to click is not going to
hover four buttons to find out which one writes to the questionnaire. `accept` is the one that went,
because it was the one carrying no consequence: applying already records agreement, and the
batch-agree-then-apply habit it existed to support is not needed, because the **fork-lineage rule is
enforced server-side** — `evaluation-apply.ts` looks up the draft this run is already editing and
converges repeated applies on it, rather than re-forking the launched original per click. The review
route still accepts `action: 'accept'`, so the capability is intact and API-accessible; it is simply
no longer a button. Existing `accepted` rows still render, and the status filter still offers them.

**The footer says what a click will do, in words.** Two labelled sections, each stating its
consequence above its button: "Change the questionnaire now", naming the actual edit, over Apply and
Edit first; and, ruled off below and quieter, "Or dismiss it" over Dismiss. `effectOf` supplies the
naming sentence and is deliberately declarative — its predecessor returned imperatives ("Rewrite the
question prompt"), which above two buttons reads as an instruction _to the reader_ rather than a
description of what Apply does.

**Four type steps, two faces, one badge.** A finding card stacks three or four paragraphs — the
question under review, the judge's suggestion, its rationale, sometimes a quote — and a reader
landing mid-card must be able to tell whether a sentence is _the questionnaire_ or _the AI's opinion
of it_, which is the one distinction the page exists to communicate.

The first attempt at that distinction announced every block: two families plus a mono chip, five
sizes (11/12/13/14/16px), three weights, italics, four badge variants, and five uppercase eyebrows
stacked down the left edge of a single card. Everything was shouting, so nothing read as more
important than anything else — the failure mode the labels were introduced to prevent, arrived at
from the other direction. The scale is now fixed at four steps and enforced by the shared module
(`components/admin/questionnaires/evaluation-field.tsx`), which carries the table:

| Role                                    | Treatment                      |
| --------------------------------------- | ------------------------------ |
| The subject of a group                  | serif, `text-lg`, regular      |
| Questionnaire wording inside a card     | serif, `text-base`, regular    |
| Prose — suggestion, rationale, evidence | sans, `text-sm`, regular       |
| Meta, labels, counts, decisions         | sans, `text-xs`, medium, muted |

The rules that hold it there:

- **Two families, one job each.** `QUESTION_FACE` is the questionnaire's voice and nothing else's;
  sans is everything the system says _about_ it. There is no third family — a raw target key set in
  mono was a developer's debug string wearing a badge, and it now renders as plain text and only
  when the target failed to resolve, where it is the sole handle the reviewer has.
- **The suggestion and the rationale carry no eyebrow.** The first paragraph says what to do, the
  muted one under it says why: headline then deck, which needs no label to be understood. Dropping
  those two is what lets the eyebrows that remain mean something — the target block, the drafted
  question, and a cited `Evidence` quote, all blocks that would genuinely be misread as the prose
  around them. `FieldLabel` / `LabelledField` stay the shared implementation, and the by-question
  group header uses the same `FieldLabel` for its context chip.
- **One badge, not four.** Severity is the only fact a reviewer triages on, so it is the only one
  that keeps colour; the judge, the raw key and the recorded decision run as one dot-separated
  `MetaRow` line. `stale` keeps its badge because it warns about the whole card rather than
  describing it, and a `pending` status prints nothing at all — it is the default state of every
  card on the page, so saying it on all of them says nothing.
- **The same card, three times over.** `policy-finding-review-card.tsx` and
  `scope-finding-review-card.tsx` are this card wearing different data. They track it exactly; they
  only stay legible while they stay identical.

The header's named-target block renders **only for `question` and `section` targets**, whose label is
real content. `goal` / `audience` / `unknown` labels merely restate the kind, which the meta row's
context already carries — a block would print the same word twice under an eyebrow saying it a
third time. When the block does render, its eyebrow carries the _full_ context ("Question 4 ·
Business Execution") and the meta row's context is dropped, so the target is named once, not twice.
The answer type and any "removed since this run" note sit _below_ the prompt in their own meta row
rather than trailing it inside the paragraph, where they were being set in the questionnaire's own
serif — the one thing that face must never say.

**A drafted question is never printed twice.** A Coverage judge writes its suggestion as `Add a
question on sales outcomes: “<the whole question>”`, and the card then previews that same drafted
prompt below in its own block. Unstripped, the reviewer meets the same sentence twice within four
lines, in two different treatments, and has to compare them word by word to discover they are
identical — the worst redundancy on the surface, and the one that made two faces collide inside a
single paragraph. `stripRestatedQuotes` removes a quoted span that restates wording the card already
prints in full (`add_question`'s prompt, `split_question`'s two halves), closes the dangling lead-in
punctuation, and returns `''` when only a fragment survives so the caller drops the paragraph
entirely. It matches after normalisation, so the curly-quote and trailing-punctuation drift between
the two copies does not defeat it. A quote reaching outside the drafted wording survives untouched.
For the same reason the "Adds a new Likert question" caption is suppressed whenever a drafted
question renders above it, under a heading that already says `Suggested new question · Likert`.

**A single judge is named once.** The verdict band already says "Proposed by Coverage" in words, so
`JudgeChips` renders nothing below one dimension — on a gap card the word "Coverage" was otherwise
appearing three times inside four lines, in three different treatments. With two or more judges the
chip row carries something the sentence cannot: the cross-judge consensus, at a glance.

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
