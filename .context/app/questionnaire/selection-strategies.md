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
from it. Default is `sequential`.

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

- **`SelectionContext`** — `{ questions, answered, config, round, sessionId, recentMessages? }`,
  all in memory. `QuestionView` is the minimal slot projection (id, key, section
  ordinal, ordinal, weight, required, type, tagIds, optional prompt).
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
`LOW_CONFIDENCE_MULT = 1.5`, `LOW_CONFIDENCE_THRESHOLD = 0.5`) are module
constants in `selection/types.ts`, not config fields — tuned in code like the
cost-estimation token constants. `weightedScores(ctx)` is exported so the math is
directly unit-testable.

## Adaptive (LLM + pgvector)

Gated behind the `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED` sub-flag (opt-in
on top of the master app flag, because it spends per turn). Flow:

1. Empty history / no deps → fall back to `weighted`.
2. Embed the last user message (`embedText`, knowledge embedder, query mode).
3. pgvector cosine top-K unanswered candidates over `AppQuestionSlot.embedding`
   (`rankSlotsByVector`, raw SQL `<=>`).
4. The seeded **`app-questionnaire-selector`** agent picks among them via
   `drainStreamChat`, returning `{ choice, rationale }`; cost is logged with
   `appQuestionnaireSessionId`.
5. **Any** failure — no deps, no embeddings, LLM/budget error, off-pool or
   unparseable pick — degrades to `weighted`, never throws. A respondent never
   sees a turn break because the LLM was down.

When the sub-flag is off, the route simply withholds deps, which lands here as the
no-deps fallback; the config editor also hides `adaptive` from the picker (unless
it's the already-saved value).

### Embeddings

`AppQuestionSlot.embedding` is a `vector(1536)` pgvector column (width matches the
platform embedding model / `AiKnowledgeChunk`). Prisma can't type it — it's
`Unsupported(...)`, read/written via raw SQL in `_lib/slot-embeddings.ts`, with an
HNSW ANN index added by raw SQL in the F4.1 migration. Generate them with the
backfill route below (idempotent; `force` re-embeds after prompt edits).

## API

| Method + path                                                | Purpose                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `POST .../versions/:vid/next-question`                       | Preview the next question for a hand-supplied answer state. No persistence. |
| `POST .../versions/:vid/embed-questions` (body `{ force? }`) | Generate/backfill slot embeddings for adaptive selection.                   |

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

### Embedding staleness (operator caveat)

Embeddings are produced **only** by the explicit backfill route — there is no
on-write hook yet. So embeddings can go stale or missing without any visible
signal, and adaptive silently degrades to `weighted` (a `logger.warn` fires when
a turn finds no embeddings). Re-run `embed-questions` (with `force: true` to
re-embed) after:

- **editing a question's prompt/guidelines** — the stored vector still reflects
  the old text;
- **adding questions** — new slots are un-embedded and excluded from ranking;
- **forking a version** — the fork copies the config (including
  `selectionStrategy: 'adaptive'`) but **not** the pgvector column, so a forked
  version starts with no embeddings.

## Not in F4.1

Session/turn/answer persistence (F4.6/P6), the streaming surface (P6), answer
extraction (F4.2), the offer-to-submit flow (F4.5). On-write / on-publish
embedding generation (today embeddings come from the explicit backfill route;
generating them on slot edits, and an admin-facing embedding-coverage indicator,
are later refinements).
