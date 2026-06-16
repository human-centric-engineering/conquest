# Answer extraction (F4.2)

How a respondent's message becomes typed **answer values** for one or more
question slots. The complement to selection (F4.1): selection decides _which
question to ask_; extraction reads the reply and records _what was answered_ —
the active question plus any others the same message happens to answer (a
**side-effect**). Built as a pure core + a capability + a no-persistence preview
route, exercisable by Vitest before any streaming surface exists (the P4 "engine
without the stream" milestone).

## Two shapes (raw LLM output → write intents)

Like ingestion (F1.1), extraction splits the LLM contract from the thing that
gets persisted:

1. **Raw LLM output** (`extraction/extraction-schema.ts`) — `{ answers: [{ slotKey,
value, confidence, provenance, rationale, sourceQuote? }] }`.
   `value` is `z.unknown()`: per-type correctness needs the slot's runtime
   `typeConfig`, which a static schema can't see, so the structured-output schema
   only does structural/enum checks (the same discipline ingestion uses for
   `suggestedTypeConfig`).
2. **`AnswerSlotIntent`** (`extraction/types.ts`) — the normalised, version-agnostic
   write-intent the route returns and **F4.6 persists**:
   `{ slotKey, questionType, value, confidence, provenance, rationale,
isActiveQuestion, sourceQuote? }`. No `sessionId`/`answerId` — those belong to
   the persistence layer that doesn't exist yet.

**No persistence in F4.2.** The session/answer tables land in F4.6/P6 (exactly as
selection deferred them). Extraction produces intents; F4.6 resolves each
`slotKey` → `AppQuestionSlot.id` and writes the answer.

## The vocabulary: provenance labels

`ANSWER_PROVENANCES` in `lib/app/questionnaire/types.ts` is the single source of
truth — four labels: `direct`, `inferred`, `synthesised`, `refined`.

- **`direct`** — stated verbatim/near-verbatim in the message (carries a `sourceQuote`).
- **`inferred`** — follows by single-step reasoning from the message, not stated.
- **`synthesised`** — combines several turns / the wider transcript; no single span.
- **`refined`** — an earlier answer updated in light of later context. Emitted by
  **F4.4** (the refinement flow — see [`answer-refinement.md`](./answer-refinement.md));
  F4.2's extractor never emits it.

F4.2's extractor is restricted to the first three via `EXTRACTOR_EMITTED_PROVENANCES`
(a `satisfies` subset of the vocabulary); the answer Zod contract derives its
`provenance` enum from that subset, so the model can't return `refined` before
there's a consumer. F4.4 now emits `refined` (only on a genuine `refine`, not an
`overwrite`) with no edit to the tuple.

## Architecture — pure core + a capability

The core lives in `lib/app/questionnaire/extraction/` and is **Prisma-free,
framework-free**. A caller assembles an in-memory `ExtractionContext`; the core
builds the prompt, and (after the LLM call) validates + normalises the answers.

```
extraction/
├── types.ts             ExtractionContext, ExtractionSlotView, AnswerSlotIntent, AnswerExtractionResult
├── extraction-schema.ts answerExtractionSchema (+ z.toJSONSchema), validateAnswerExtraction
├── answer-value.ts      validateAnswerValue(type, value, typeConfig) — per-type value check
├── extraction-prompt.ts buildAnswerExtractionPrompt / buildAnswerExtractionRetryMessage → LlmMessage[]
└── answer-intents.ts    normalizeAnswerIntents(answers, ctx) → { intents, dropped }
```

- **`ExtractionContext`** — `{ activeQuestionKey, candidateSlots, answered,
userMessage, recentMessages?, sessionId }`, all in memory. `ExtractionSlotView`
  is the slot projection (key, type, `typeConfig`, prompt, required; `id`/`sectionId`
  optional — the pure path never reads them, the route carries them for F4.6).
- **Candidacy** — `candidateSlots` is the version's **unanswered slots plus the
  active slot** (re-answering an answered slot is F4.4's `refined` job). The route
  builds it; a hard `.max()` cap bounds prompt size and cost.
- **Value validation** reuses the F2.1 authoring schemas (`typeConfigSchemaFor`)
  so a `single_choice` value must be one of _that slot's_ choices, a `likert`
  within its scale, etc. Lenient where the LLM is loose (a numeric `"34"`, a
  boolean `"yes"`), strict where correctness matters.
- **Choice resolution is by value _or_ label.** The extractor is told to emit the
  choice's `value`, but real model output routinely sends the human **label**
  (`"Engineering"`) or a cased/spaced variant of the slug. `validateSingleChoice`/
  `validateMultiChoice` resolve a candidate against each choice's `value` and `label`
  case-insensitively (trimmed) and **normalise back to the canonical slug** — so a
  clearly-made choice is kept, not dropped as `value invalid for type`. An exact
  `value` match always wins a label/value collision; an off-list candidate is still
  dropped unless the slot sets `allowOther`. This matters most in data-slot mode,
  where demographic-style `single_choice` questions fill from side-effect extraction
  of an open conversational answer — a label/casing mismatch there would silently
  leave the question (and its section progress) unanswered. Note this resolves
  _surface form_, not _semantics_: mapping `"10 years"` → the `3+ years` bucket is
  still the model's job (it is given the options), not the validator's.

### `normalizeAnswerIntents` (the change-records analogue)

Pure data-in/data-out; normalises or drops an individual odd answer rather than
failing the whole turn:

| Situation                                   | Outcome                                          |
| ------------------------------------------- | ------------------------------------------------ |
| `slotKey` not a candidate                   | **drop** (`unknown slot key`)                    |
| value fails the slot's type/config          | **drop** (`value invalid for type: …`)           |
| `direct` with a missing/blank `sourceQuote` | **downgrade** to `inferred` (can't substantiate) |
| same slot answered twice                    | **dedupe** — keep the highest-confidence intent  |

The intent's `questionType` is always resolved from the slot, never from the
model — the slot's type is authoritative.

`isActiveQuestion` is set by comparing `slotKey` to `ctx.activeQuestionKey`.

## The capability

`AppExtractAnswerSlotsCapability` (`lib/app/questionnaire/capabilities/extract-answer-slots.ts`)
extends `BaseCapability`, mirroring the F1.1 structure extractor: resolve the
provider/model binding → `getProvider` → `runStructuredCompletion` (call →
parse → retry-once → cost-sum) → fire-and-forget `logCost` → `normalizeAnswerIntents`
→ `this.success({ intents })`. Error codes: `no_provider_configured`,
`provider_unavailable`, `extraction_failed`.

- **Tier `chat`**, not `reasoning` — extraction runs per turn and must be snappy
  (`maxTokens` 4 000, timeout 30 s), unlike the one-off multi-page ingest.
- **`processesPii = true`** — the message, transcript, and prior answers are
  respondent PII. `redactProvenance()` redacts them and emits a **counts-only**
  result preview (intent/active/side-effect counts + per-label counts), never the
  values or source quotes.
- A **distinct agent** (`app-questionnaire-answer-extractor`, seed 006) from the
  document extractor and the selection agent — different job, far higher volume,
  its own monthly budget ceiling. Capability + binding in seed 007.

## The preview route

`POST /api/v1/app/questionnaires/:id/versions/:vid/extract-answer` —
`withQuestionnairesEnabled(withAdminAuth(…))`.

- Body: `{ activeQuestionKey, userMessage, answered?: { key, confidence? }[],
recentMessages? }`.
- **Sub-flag gate** — `APP_QUESTIONNAIRES_ANSWER_EXTRACTION_ENABLED` (seed 008,
  off by default), on top of the master flag, because every call spends an LLM
  completion. Off → 404 (looks like a missing route, consistent with the master
  gate). Same opt-in shape as adaptive selection.
- **Per-admin LLM sub-cap** — `answerExtractionLimiter` (60/min), keyed on the
  admin who owns the spend; the section 100/min is too loose for a paid per-turn
  call.
- **DB seam** — `_lib/extraction-context.ts` `buildExtractionContext` is the only
  Prisma in the feature: it loads the version's slots, resolves the active key,
  and builds the candidate pool. An unknown `activeQuestionKey` is a **400**
  (the version exists; the key is load-bearing) — a deliberate divergence from
  next-question's "drop unknown keys" leniency for `answered`.
- **Fail-soft** — a capability error returns `200` with `{ intents: [],
diagnostic }`, never a 5xx: extraction has no deterministic fallback, but the
  engine (F4.6) must keep the conversation going rather than crash a turn.
- Persists nothing — a true preview, the proven seam F4.6 calls.

## Who consumes it

F4.6 (session state machine) wires persistence: it will call this extraction seam
per turn and write `AnswerSlotIntent`s to the answer table. F4.3 (contradiction
detection) and F4.4 (refinement, which adds the `refined` provenance) build on the
recorded answers. The `confidence` an intent carries feeds the F4.1 `weighted`
strategy's low-confidence-section boost once answers are persisted.

## Not in F4.2

Persistence + the session/answer tables (F4.6/P6); contradiction detection (F4.3);
answer refinement and the `refined` provenance transition (F4.4); the
offer-to-submit flow (F4.5); the streaming chat surface (P6). Smarter side-effect
candidacy (section-proximity / required-only instead of "all unanswered") is a
later refinement, the way F4.1 deferred on-write embeddings.
