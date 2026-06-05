# Answer refinement (F4.4)

How an already-captured **answer** is updated in light of later context — the
respondent reconciles a contradiction F4.3 surfaced, or simply clarifies something
they said earlier. The fourth of P4's conversational primitives after selection (F4.1,
_which_ question), extraction (F4.2, _what_ was answered), and detection (F4.3, _do the
answers conflict_). F4.4 is the **update**: it decides whether to change an answer,
preserves a refinement history, and — unlike F4.1–F4.3 — **persists** the result.

Built as a pure core + a capability + a read/write route, on top of the
answer-persistence foundation F4.4 introduces.

## The three actions

The refiner decides one of `REFINEMENT_ACTIONS = ['refine','overwrite','leave']`
(`refinement/types.ts`, a core-local tuple — the analogue of `CONTRADICTION_SEVERITIES`)
per slot:

- **`refine`** — the value genuinely **evolves** in light of later context (the
  canonical case: contradiction resolution, "earlier I rounded, it's actually 34").
  Provenance becomes **`refined`**; a history entry preserves the prior value.
- **`overwrite`** — a straight **correction** of a mistaken capture (a typo, the wrong
  option, a model mis-extraction). The prior value was never what the respondent meant,
  so provenance is **kept** (a typo fix is not an evolution) — but a history entry is
  still appended so the prior value isn't silently lost.
- **`leave`** — the new context doesn't change this slot. A no-op; the normaliser
  filters it out so it never reaches the apply step.

**Why `overwrite` keeps its provenance:** `refined` is a precise signal meaning "this
value is the product of an evolution across turns" — useful to reviewers and analytics.
Labelling a typo fix `refined` would dilute that signal, so only a genuine `refine`
transitions the label. Both still append to `refinementHistory` (auditability is
non-negotiable); the entry's `source` (`contradiction` | `clarification` | `correction`,
`REFINEMENT_SOURCES`) records which flow drove it.

F4.4 is the **first and only emitter of `refined`** in `ANSWER_PROVENANCES`
(`lib/app/questionnaire/types.ts`) — it was reserved by F4.2 (excluded from
`EXTRACTOR_EMITTED_PROVENANCES`) and consumed here with no tuple edit. A parity test
pins this.

## The decision contract

Like extraction/detection, refinement splits the LLM contract from what callers
consume:

1. **Raw LLM output** (`refinement/refinement-schema.ts`) — `{ refinements:
[{ slotKey, action, newValue?, rationale, source, confidence }] }`. Structural/enum
   checks only (`action` in `REFINEMENT_ACTIONS`, `source` in `REFINEMENT_SOURCES`,
   `confidence` 0–1). `newValue` is open `unknown` and optional — the
   refine/overwrite-requires-a-value rule and per-type validity are downstream.
2. **`RefinementDecision`** (`refinement/types.ts`) — the normalised, version-agnostic
   intent: `{ slotKey, action (never leave), questionType, newValue, rationale, source,
confidence }`. The `questionType` is resolved from the slot, never the LLM's claim.

### The normaliser (`normalizeRefinementDecisions`)

Drops one odd decision rather than failing the pass (the F4.2 doctrine):

- **Unknown slot key** → drop.
- **Slot not already answered** → drop (you can't refine an unanswered slot — the
  analogue of F4.3's unanswered-slot drop).
- **`leave`** → filtered out (a deliberate non-change, not an error).
- **`refine`/`overwrite` without a `newValue`** → drop.
- **`newValue` fails the slot's type** → drop. Validated by reusing F4.2's
  `validateAnswerValue` (`extraction/answer-value.ts`), which reads F2.1's
  `typeConfigSchemaFor` — a refined value obeys the identical choice-membership /
  likert / numeric rules as a freshly extracted one. Zero duplicated validation.
- **No-op** (the validated new value equals the existing one, order-insensitive for
  multi_choice) → drop (don't churn history with an identical entry).
- **Duplicate per slot** → keep the highest-confidence decision (stable tie).

## The write path: `applyRefinement` + the persistence seam

`applyRefinement(existing, decision)` (`refinement/refinement-logic.ts`) is the pure,
deterministic merge — the "refinementHistory write path" realized as logic:

- Never mutates `existing`.
- Builds a `RefinementHistoryEntry` from the **pre-change** state
  (`{ previousValue, previousProvenance, newValue, rationale, source, turnIndex? }`)
  and appends it to the existing history.
- Sets provenance to `refined` **only** for `refine`; `overwrite` keeps the original.

**No clock in the core.** `RefinementHistoryEntry` carries no timestamp — the pure core
has no clock (so replays stay deterministic). The persistence seam stamps `createdAt`
at write time. `turnIndex` is optional and caller-supplied; the real turn loop (F4.6)
provides it.

The DB I/O lives in `app/api/v1/app/questionnaires/_lib/answer-slots.ts` (the
write seam, keeping `lib/app/questionnaire/refinement/**` Prisma-free):

- `getOrCreatePreviewSession(versionId)` — idempotent per-version preview session
  (`isPreview: true`).
- `upsertAnswerSlot(sessionId, questionSlotId, answer)` — seed the supplied existing
  answer (the "seed then refine" step), keyed on `@@unique([sessionId, questionSlotId])`.
- `loadAnswerSlot(sessionId, questionSlotId)` — shape a row for `applyRefinement`,
  narrowing the stored `provenanceLabel` to the enum.
- `persistRefinement(rowId, refined)` — write `value`, `provenanceLabel`, and the
  extended `refinementHistory`, stamping `createdAt` on any unstamped entry.

## Persistence foundation (the F4.6 slice F4.4 introduces)

Unlike F4.1–F4.3 (no-persistence previews), F4.4 lands the answer tables, in
`prisma/schema/app-questionnaire.prisma`:

- **`AppQuestionnaireSession`** (minimal) — `{ versionId (FK, cascade), status
(SESSION_STATUSES), isPreview, respondentUserId? (plain String, no FK — UG-1) }`. The
  full session/turn lifecycle is F4.6's; this anchors answer rows. `isPreview` marks
  admin refine-answer exercises so P8 analytics exclude them.
- **`AppAnswerSlot`** — `{ sessionId (FK, cascade), questionSlotId (FK, cascade), value
Json, confidence Float? (0–1), provenanceLabel String (ANSWER_PROVENANCES, validated
at the boundary — not a Prisma enum, house style), provenanceItems Json? (Sunrise
contract; not populated by F4.4), rationale, lastUpdatedTurnId? (F4.6 seam),
refinementHistory Json default [] }`, unique on `(sessionId, questionSlotId)`.

The migration was generated `--create-only` with the phantom pgvector `DROP INDEX`
statements stripped before applying (see `.context/database/migrations.md` and the
drift warning on `AppQuestionSlot`).

## Capability, agent, sub-flag

- **`AppRefineAnswerCapability`** (`capabilities/refine-answer.ts`) — a `BaseCapability`
  running one provider-agnostic structured LLM call (call → parse →
  retry-once-at-temp-0 → cost-sum), then the normaliser. Returns **decisions only**
  (persists nothing — the route applies + writes). `processesPii = true` with a
  counts-only `redactProvenance`. Dispatched by slug `app_refine_answer`.
- **Answer-refiner agent** (`app-questionnaire-answer-refiner`, seed 012) — distinct
  from the extractor (006) and detector (009): its own cadence, persona, and
  `monthlyBudgetUsd`. Resolves the `chat` tier; ships with empty model/provider
  (dynamic resolution). `visibility: 'internal'`.
- **Sub-flag** `APP_QUESTIONNAIRES_ANSWER_REFINEMENT_ENABLED` (seed 014, disabled) on
  top of the master flag — refinement spends an LLM call per pass.
  `isAnswerRefinementEnabled()` requires both.

## The route (read/write)

`POST /api/v1/app/questionnaires/:id/versions/:vid/refine-answer` — admin-only.

Gate order: `withQuestionnairesEnabled` (404 master-off, before auth) → `withAdminAuth`
(401/403) → `isAnswerRefinementEnabled()` (404 sub-flag-off) → `validateRequestBody`
(400) → `answerRefinementLimiter` (429, 60/min per admin) → `buildRefinementContext`
(404 version, 400 no-resolvable-answers) → seed the supplied answers into the preview
session → load the refiner agent (404 if unseeded) → dispatch → for each decision:
`loadAnswerSlot` → `applyRefinement` → `persistRefinement` → respond.

Body: `{ existingAnswers: [{ key, value, provenance, rationale?, confidence?,
turnIndex? }] (≥1), userMessage?, triggeringContradiction? }`. Response: `{ decisions,
persistedSlots, summary }` where `summary` is the counts-only roll-up shared with the
capability's audit preview (drift-proof).

**Fail-soft:** a capability/LLM error → 200 with empty decisions + a `diagnostic`,
never a 5xx (the idempotent seed upsert may already have persisted).

Unlike the F4.2/F4.3 preview routes, this route **persists** — it creates real
`AppQuestionnaireSession` (preview) + `AppAnswerSlot` rows. This is the deliberate
consequence of pulling the persistence foundation forward into F4.4.

## Who consumes it (F4.6 seam)

The streaming engine (F4.6) wires the live per-turn loop: after extraction/detection,
it calls the refiner when a contradiction is reconciled or a respondent clarifies an
earlier answer, then applies + persists via these same primitives — populating
`turnIndex`/`lastUpdatedTurnId` from the real turn loop. F4.3's `suggestedProbe` is the
detection→refinement handoff, carried into the refiner's `triggeringContradiction`.

## See also

- [`answer-extraction.md`](./answer-extraction.md) — F4.2, the `refined`/F4.4 seam it
  reserved (now realized) and the `validateAnswerValue` this reuses.
- [`contradiction-detection.md`](./contradiction-detection.md) — F4.3, whose
  `suggestedProbe` handoff F4.4 consumes.
- [`.context/database/migrations.md`](../../database/migrations.md) — the app-migration
  create-only + strip-pgvector discipline.
