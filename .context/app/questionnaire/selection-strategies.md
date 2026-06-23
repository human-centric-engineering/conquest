# Selection strategies (F4.1)

How the conversational engine decides **which question to ask next**. Four
pluggable strategies, selectable per version via the `selectionStrategy` config
field (F3.1). Built as pure functions exercisable by Vitest before any streaming
surface exists — the P4 "engine without the stream" milestone.

## The four strategies

| Slug         | Picks                                                                                                  | Cost | Determinism                          |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------ |
| `sequential` | First unanswered question in document order `(section.ordinal, ordinal)`.                              | $0   | Deterministic                        |
| `random`     | Uniform random among unanswered (required first), seeded on `sessionId + round`.                       | $0   | Deterministic per `(session, round)` |
| `weighted`   | Highest-scoring unanswered question (weight × section-coverage × low-confidence pull). Required first. | $0   | Deterministic                        |
| `adaptive`   | LLM picks among the most semantically-similar unanswered questions to the last message.                | >$0  | Non-deterministic (LLM)              |

`SELECTION_STRATEGIES` in `lib/app/questionnaire/types.ts` is the single source
of truth; the config Zod schema, the editor's picker, and the registry all derive
from it. Default is `adaptive` (`DEFAULT_QUESTIONNAIRE_CONFIG` + the
`AppQuestionnaireConfig.selectionStrategy` column default, set by migration
`20260618143001_app_config_default_adaptive_strategy`) — new questionnaires get
respondent-led selection out of the box, gated by the adaptive sub-flag below.

## Architecture — pure core + injected deps

The strategies live in `lib/app/questionnaire/selection/` and are **Prisma-free**.
Session/turn/answer tables don't exist yet (F4.6/P6), so a strategy reads an
in-memory `SelectionContext` a caller assembles — a test harness today, the
streaming engine later. That's what makes every per-turn behaviour unit-testable
by hand.

```
selection/
├── types.ts      SelectionContext, SelectionDecision, SelectionStrategyPlugin, StrategyDeps, constants
├── context.ts    pure helpers: unanswered, coverageRatio, requiredFirstPool, terminalDecision
├── registry.ts   slug → plugin (modelled on the grader registry)
├── strategies/   sequential · random · weighted · adaptive
└── index.ts      barrel: auto-registers each strategy, exports KNOWN_STRATEGY_SLUGS
```

- **`SelectionContext`** — `{ questions, answered, config, round, sessionId, recentMessages?, goal? }`,
  all in memory. `QuestionView` is the minimal slot projection (id, key, section
  ordinal, ordinal, weight, required, type, tagIds, optional prompt, and — for the
  adaptive selector only — optional `guidelines`/`rationale`). `goal` and the
  per-candidate `guidelines`/`rationale` are read by `adaptive` alone; the
  deterministic strategies ignore them.
- **`SelectionDecision`** — `ask` (with `questionId`, `rationale`, `costUsd`),
  `complete` (terminal condition met), or `none` (nothing left but thresholds
  unmet). F4.1 only _computes_ `complete`; the offer-to-submit flow is F4.5.
- **`StrategyDeps`** — the impure surface (`embedText`, `rankByVector`, `llmPick`)
  injected only into `adaptive`. The deterministic strategies ignore it. Keeps
  `lib/` pure and the adaptive logic mockable; the real deps are wired at the route
  seam (`_lib/adaptive-deps.ts`).

Adding a strategy is one file in `strategies/` + one import line in `index.ts` + a
slug in `SELECTION_STRATEGIES`. A parity test asserts the registry and the enum
match exactly, so a forgotten registration fails CI rather than throwing at
runtime for a valid config value.

## Terminal conditions (shared)

Every strategy calls `terminalDecision(ctx)` first:

1. `maxQuestionsPerSession` reached → `complete` (even below coverage).
2. Weighted coverage ≥ `coverageThreshold` **and** answered ≥ `minQuestionsAnswered` → `complete`.
3. Nothing left to ask but thresholds unmet → `none`.

Otherwise it returns `null` and the strategy picks from the remaining pool.
`coverageRatio` is weighted (answered weight ÷ total weight), and a version with
no questions / all-zero weights is trivially covered (returns 1).

## Weighted scoring

Per unanswered question, within the required-first pool:

```
score = weight
      × (1 + UNDERCOVERED_SECTION_BONUS × sectionInverseCompletion)
      × (lowConfidenceInSection ? LOW_CONFIDENCE_MULT : 1)
```

Ties break on document order. The constants (`UNDERCOVERED_SECTION_BONUS = 0.5`,
`LOW_CONFIDENCE_MULT = 1.5`, `LOW_CONFIDENCE_THRESHOLD = 0.6`) are module
constants in `selection/types.ts`, not config fields — tuned in code like the
cost-estimation token constants. `LOW_CONFIDENCE_THRESHOLD` is 0.6 (not 0.5) so it captures the
finer extraction rubric's terse/vague band (~0.45–0.6) as "shaky ground worth revisiting" while a
clear, direct answer (≥0.75) sits safely above it. `weightedScores(ctx)` is exported so the math is
directly unit-testable.

**Adaptive deepens shaky ground too.** The `adaptive` strategy now also reads confidence: it flags
each candidate that sits in a section already holding a low-confidence answer (`sectionLowConfidence`,
same threshold), and `buildSelectorPrompt` surfaces that as a "We're unsure here — probe to deepen it"
sub-line. The selector's system prompt (seed `005-selection-agent`) is told to lean toward such a
candidate as a genuine follow-up. **The seed must be re-seeded (`npm run db:seed`) or admin-edited for
the instruction change to take effect** — re-seeding only re-asserts `isSystem`, so an existing agent
keeps its stored instructions.

**Where `weight` comes from.** `AppQuestionSlot.weight` is the base above and the
numerator of `coverageRatio`. Admins set it per question in the **Structure editor** via a
bounded **slider** — `0.1` (lightest) … `1.0` (heaviest) in `0.1` steps — which PATCHes
`…/questions/:id`; the authoring create/update schemas enforce that range. Every creation
path now defaults to the neutral midpoint `0.5` (leaving headroom both ways): the
`AppQuestionSlot.weight` column default, ingestion (`persist.ts`), re-ingest
reconciliation (`planner.ts`), and the add-question route all land at `0.5`, and the
`20260614083622_app_question_weight_default_05` migration backfilled every pre-existing
question to `0.5`. Because scoring is relative/scale-invariant, the absolute value is a UX
choice, not a behavioural one. Weight is independent of **tags** — tags are
organisational labels for analytics/export filtering only and are read by no selection
strategy (`SelectionContext.tagIds` is plumbed but currently unused). Weight only changes
behaviour under `weighted`; the other strategies ignore the base but every strategy still
completes via the weighted `coverageRatio`.

## Adaptive (LLM + pgvector)

Gated behind the `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED` sub-flag (opt-in
on top of the master app flag, because it spends per turn). Flow:

1. Empty history / no deps → fall back to `weighted`.
2. Embed the last user message (`embedText`, knowledge embedder, query mode).
3. pgvector cosine top-K unanswered candidates over `AppQuestionSlot.embedding`
   (`rankSlotsByVector`, raw SQL `<=>`).
4. The seeded **`app-questionnaire-selector`** agent picks among them via a
   **direct structured completion** (`runSelectorCompletion`, `_lib/selector-completion.ts`),
   returning `{ choice, rationale }`; cost is logged with `appQuestionnaireSessionId`.
5. **Any** failure — no deps, no embeddings, LLM/budget error, off-pool or
   unparseable pick — degrades to `weighted`, never throws. A respondent never
   sees a turn break because the LLM was down.

When the sub-flag is off, the route simply withholds deps, which lands here as the
no-deps fallback; the config editor also hides `adaptive` from the picker (unless
it's the already-saved value).

**What the selector sees.** The agent's **system prompt is load-bearing** — unlike
the capability-dispatched agents, the selector runs as a direct structured completion
(`runSelectorCompletion`, the same mechanism the seriousness/sensitivity judges use), so its
editable `systemInstructions` (seed `005-selection-agent.ts`) _are_ the system prompt
sent to the model. Editing it in the admin UI changes selection. The per-turn **user**
message is assembled by `buildSelectorPrompt` (`_lib/adaptive-deps.ts`) and carries:
the questionnaire **goal** (version-level framing), the recent transcript, the
**already-answered** questions (so it doesn't re-tread them), and the **candidate
list** — each candidate rendered with its `guidelines` ("looking for") and `rationale`
("why it matters") so the model judges on intent, not just prompt wording. `goal`
threads onto `SelectionContext` (the preview builder sets it directly; the live turn
loop passes `meta.goal` via `buildTurnInvokers`); `guidelines`/`rationale` ride on
`QuestionView`. All of it is optional — absent fields are simply omitted from the prompt.

**Follow where the respondent is steering.** The selector prompt leads with this: when the respondent
volunteers, dwells on, or voices a strong opinion about a specific topic ("our KPIs are useless", "I
want to talk about X"), the selector picks the candidate matching **that** topic even when it sits in
a different area from the one being explored — a clearly volunteered topic outweighs finishing the
current area and outweighs the listed order. Only when nothing has been strongly volunteered does it
fall back to continuity/goal-fit. (Data-slot mode has the analogous [deepen-a-tangent](data-slots.md#deepen-a-volunteered-tangent-be-led-by-the-respondent)
re-surfacing for just-volunteered off-topic fills.)

### Embeddings

`AppQuestionSlot.embedding` is a `vector(1536)` pgvector column (width matches the
platform embedding model / `AiKnowledgeChunk`). Prisma can't type it — it's
`Unsupported(...)`, read/written via raw SQL in `_lib/slot-embeddings.ts`, with an
HNSW ANN index added by raw SQL in the F4.1 migration. Generate them with the
backfill route below (idempotent; `force` re-embeds after prompt edits).

> **Data slots have a parallel.** Data-slot mode (the `runDataSlotTurn` loop) doesn't use these
> strategies — its targeting is deterministic topic-local. At 50+ data slots it gains an analogous
> **adaptive data-slot selection** with its own `AppDataSlot.embedding` column + selector. See
> [Adaptive data-slot selection](data-slots.md#adaptive-data-slot-selection-50-slot-scale).

## API

| Method + path                                                | Purpose                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `POST .../versions/:vid/next-question`                       | Preview the next question for a hand-supplied answer state. No persistence.      |
| `GET .../versions/:vid/embed-questions`                      | Embedding coverage `{ total, embedded, missing }` (Settings step + launch gate). |
| `POST .../versions/:vid/embed-questions` (body `{ force? }`) | Generate/backfill slot embeddings for adaptive selection.                        |

Both are admin-only and 404 behind the master flag. `next-question` runs the
deterministic strategies with no sub-cap (section 100/min); the `adaptive` path
takes a per-admin sub-cap (`adaptiveSelectionLimiter`), and the embedding backfill
takes its own (`embedSlotsLimiter`).

`next-question` body: `{ answered?: {key, confidence?}[], recentMessages?,
round?, sessionId?, strategyOverride? }` → `{ strategy, decision, question? }`.

## Who consumes it

- **P6 streaming engine** — calls the selection seam each turn with real session
  state (the preview route proves the contract).
- **F4.5 completion logic** — reads the `complete` / `none` terminal signals.
- **F4.3 contradiction detection** — independent (reads `contradictionMode`), but
  shares the per-turn loop.
- **F4.2 answer extraction** — produces the `confidence` per answered slot that
  the `weighted` scorer's low-confidence-section boost reads (see
  [answer extraction](answer-extraction.md)).

### Lazy embedding on first adaptive turn

Nothing in the authoring flow generates embeddings, so a version configured for
`adaptive` would otherwise rank against an empty set and silently degrade to
`weighted` (sequential-looking) forever. The live turn route closes that gap: when
the adaptive sub-flag is on **and** the version's `selectionStrategy === 'adaptive'`,
`POST .../questionnaire-sessions/:id/messages` calls `ensureVersionSlotsEmbedded`
(`_lib/slot-embeddings.ts`) before the turn runs. A single `COUNT(… IS NULL)`
short-circuits to a no-op once the version is fully embedded, so only the **first**
session of a fresh version pays the embed cost; subsequent turns are free. It's
**fail-soft** — a missing/misconfigured embedder is caught and logged, and the turn
proceeds on the `weighted` fallback rather than breaking. So selecting "Adaptive
(agent-chosen)" in settings now works without any manual backfill step.

### Admin surfaces: the explicit step + launch gate

Two admin surfaces make the embedding requirement visible rather than relying on the lazy
backstop alone:

- **Settings tab — "Generate embeddings" step.** When the selection strategy is set to
  `adaptive`, the config editor renders `<AdaptiveEmbeddingStep>` directly under the strategy
  picker. It reads coverage from `GET …/embed-questions` and shows the state (N of M embedded /
  all embedded / no questions yet), with a **Generate embeddings** button (`POST …/embed-questions`)
  — and a **Re-embed all** (`force: true`) once fully embedded, for refreshing after prompt edits.
  After a generate it refetches coverage and `router.refresh()`es so the launch checklist updates.

- **Review & Launch — "Questions embedded" check.** `launchReadinessChecks` adds an `embeddings`
  check **only** when `embeddingsRequired` (the version is `adaptive` and the sub-flag is on). The
  launch gate (`status` route → `loadLaunchReadiness`) blocks `draft → launched` until every slot
  is embedded; the checklist row links to the Settings tab. This is **launch-only** — the _preview_
  gate (`createPreviewSession` → `loadLaunchReadiness(vid, { includeEmbeddings: false })`) skips it,
  so an admin can still rehearse a draft before embedding (the lazy backstop covers the turn loop).
  A non-adaptive version never sees this check; a version whose adaptive sub-flag is off doesn't
  either (it degrades to `weighted` at runtime, so embeddings are irrelevant).

### Embedding staleness (operator caveat)

The lazy ensure embeds only the **missing** (un-embedded) slots — it does not
re-embed a slot whose stored vector has gone stale. So after **editing a
question's prompt/guidelines**, the stored vector still reflects the old text;
re-run `embed-questions` with `force: true` to refresh it. Newly **added**
questions and **forked** versions (the fork copies the config but not the pgvector
column) self-heal on their next adaptive session via the lazy ensure above — no
manual step needed.

## Not in F4.1

Session/turn/answer persistence (F4.6/P6), the streaming surface (P6), answer
extraction (F4.2), the offer-to-submit flow (F4.5). On-write / on-publish
embedding generation (embeddings are generated lazily on the first adaptive turn —
see "Lazy embedding" above — via the Settings-tab step, or the explicit backfill
route; automatic re-embedding on slot _edits_ is a later refinement — for now the
admin re-embeds with `force` after editing question wording).
