# Data Slots — the semantic abstraction layer over questions

> **Sub-flag.** `APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED` (`isDataSlotsEnabled`). Off by default.
> The runtime mode additionally requires `APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED`.

## The idea

The deliverable is still the **questions** the admin authored. But form-filling is boring, so we
don't make the respondent answer them one by one. Instead an agent infers a small set of **data
slots** — short (1–4 word) semantic targets, each with a description — that abstract over the
questions. The live conversation targets the **data slots** naturally, like being interviewed by a
skilled consultant/coach; in the background the same turn fills the underlying questions. The
respondent sees the data slots filling (with a paraphrase of their position + a confidence
indicator); they never see the raw question answers. **All questions must be answered to complete.**

Two layers, in parallel:

| Layer      | Models                              | Role                                        | Visibility                                                               |
| ---------- | ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Questions  | `AppQuestionSlot` / `AppAnswerSlot` | The deliverable; filled in the background   | Hidden from the respondent; admin reads post-completion via F8.2 exports |
| Data slots | `AppDataSlot` / `AppDataSlotFill`   | The respondent-facing conversational target | Shown live in the right panel                                            |

`AppDataSlot` ↔ `AppQuestionSlot` is **M:N** (`AppDataSlotQuestion`) — a slot meaningfully captures
one or more questions. Data slots are version-scoped and fork with the version (like tags), copied
by `copyVersionGraph`.

`AppDataSlot` is exclusively the **saved/live** set. A generated-but-unsaved proposal lives in a
separate `AppDataSlotDraft` (one JSON-snapshot row per version, `versionId @unique`, cascades with
the version) so it survives navigation without ever being mistaken for live — runtime targeting, the
respondent panel, and the launch gate never read it. See the generate → review → launch-gate flow
below for the draft lifecycle (generate persists it, save promotes + clears it, discard drops it).

## Admin: generate → review → launch gate

1. After questions are extracted + approved, the version detail page shows **Data slots** (draft +
   launched). It links to `/admin/questionnaires/:id/data-slots`.
2. **Generate** dispatches `app_generate_data_slots` (the `app-questionnaire-data-slots-generator`
   agent) over the version's questions → proposed slots (name + description + theme + question
   mappings). The admin picks a **granularity** first — a 5-level knob (`broadest` → `broad` →
   `balanced` (default) → `granular` → `finest`, see `data-slots/granularity.ts`) sent in the POST
   body. Each level carries a **target ratio** of slots-to-questions (broadest ≈0.15–0.25 …
   balanced ≈0.45–0.55, i.e. about half … finest ≈0.85–1.0) — `targetSlotRange()` turns that into
   a concrete count band the prompt tells the model to hit (qualitative guidance alone drifts
   toward 1:1). The map step gets a per-section target; the merge step gets the **global** target,
   so it consolidates across sections to land near it. The prompt also demands **detailed**
   descriptions (up to 1000 chars) that carry the full intent of the question(s) a slot abstracts,
   because the slot description is the brief the runtime interviewer phrases from.
   The admin UI generates via the **streaming map-reduce** endpoint
   `POST …/versions/:vid/data-slots/generate/stream` (SSE): the orchestrator
   (`data-slots/generate-stream.ts`) groups questions by section (splitting sections over ~12
   questions), generates slots per section **in parallel** (capped concurrency), then runs one
   **merge** call to reconcile duplicates + guarantee full coverage. This avoids the single-call
   truncation that large questionnaires hit, and emits progress events (`start` →
   `group_done`/`group_error`\* → `merge_start` → `done`, see `generation-events.ts`) so the admin
   watches slots build section by section (`DataSlotGenerationProgress`). If the merge call fails
   it falls back to a deduped union (`merge_warning`). The non-streaming, single-shot capability
   (`app_generate_data_slots`, `POST …/data-slots/generate`) stays for API consumers.
   Either path persists the final set as the version's pending **draft** (`AppDataSlotDraft`, one
   JSON row per version) so it survives the admin navigating away — but the draft is **not live**:
   runtime, the respondent panel, and the launch gate read only the saved set (`AppDataSlot`).
   A fail-soft (empty) generation persists nothing.
3. The admin reviews/edits each slot, then **Save** (`PUT …/versions/:vid/data-slots`)
   replaces the version's slots (fork-safe) AND clears the pending draft in the same transaction
   (promoting the reviewed set to live). `theme` is the generator's grouping label. **Discard**
   (`DELETE …/versions/:vid/data-slots/draft`) drops the proposal, leaving the live set untouched.
   The review surface mirrors the runtime hierarchy: slots are **grouped under one editable theme
   heading** (renaming it re-themes every slot in the group — the same exact-match grouping the
   respondent panel uses), each card carrying name → description → covered-questions. Draft-vs-live
   status is shown once (the "draft / not live yet" banner + the "Save & make live" button), not per
   slot. An unsaved-edits navigation guard (`useUnsavedChangesWarning`) covers in-progress edits —
   every slot in the working set is saved (there is no per-slot accept/reject).
   3a. **Refine one slot** — each card has a **Refine with AI** control: the admin types free-text
   instructions and `POST …/versions/:vid/data-slots/refine` dispatches `app_refine_data_slot` (the
   same generator agent, `reasoning` tier) over that slot + the version's full question set + the
   other slots' names/themes (`siblingSlots`, so it stays distinct and keeps the theme consistent
   with the set), returning ONE rewritten slot (name, description, theme, and **re-suggested**
   question coverage).
   It's a thin compute endpoint — **persists nothing**; the result splices into the working set in
   place (like a manual edit) and commits with the next Save. Fail-soft: a refiner failure returns
   `slot: null` + a diagnostic, not a 5xx. Per-admin sub-cap `dataSlotsRefineLimiter` (60/min).
   3b. **Assign orphaned questions** — a question added _after_ the slots were generated (a hand-add,
   a re-ingest, or a design-evaluation `add_question` suggestion) is covered by no slot. `POST
…/versions/:vid/data-slots/assign` (body `{ questionKeys? }`, default = all orphans) dispatches
   `app_assign_data_slots` (the same generator agent, `reasoning` tier): for each orphan it decides
   an EXISTING slot (by `key`) or a NEW one, returning **placements only** — the route's
   deterministic `mergeAssignments` does the writing, so existing slots are preserved verbatim and
   only gain keys (a `new` name that matches an existing slot folds in; an orphan the model misses
   gets a prompt-derived fallback slot — never left behind). Unlike refine, this **writes live**
   (`replaceDataSlots`, fork-if-launched) — it's the automated "slot it" action. Fail-soft (returns
   unchanged slots + a diagnostic). Per-admin sub-cap `dataSlotsAssignLimiter` (20/min). Surfaced
   three ways: a pre-ticked **"Add to a data slot (create one if needed)"** checkbox on the two
   add-a-question paths (the design-evaluation finding card's one-click "Add to questionnaire" and
   the structure editor's seed composer — both shown only when the version already has slots), and a
   catch-all **"Assign … with AI"** button on this review surface's unslotted-questions banner.
4. **Launch gate:** when the flag is on, "Data slots generated" is a launch-checklist item
   (client `LaunchChecklist` + server `assertLaunchable`), counting only **saved** `AppDataSlot`
   rows — a pending draft does not satisfy the gate — so every launched questionnaire runs in
   data-slot mode.

## Backfilling pre-existing questionnaires (headless generate → save live)

Questionnaires created before data slots shipped have none. To give them their abstraction
without admin clicks there's a headless seam, `generateAndSaveDataSlots(questionnaireId,
versionId, { granularity? })` (`app/api/v1/app/questionnaires/_lib/generate-data-slots.ts`). It
runs the **same** `app-questionnaire-data-slots-generator` agent via the single-shot
`app_generate_data_slots` capability, then writes the result **live** (`replaceDataSlots`) —
skipping the draft/review step the admin UI uses. It's fail-soft: a question-less version, a
missing agent (`db:seed` not run), or a generator failure (no provider / timeout / parse) returns
a structured `{ status, slotCount, diagnostic?, message? }` instead of throwing. (It uses the
single-shot capability, not the streaming map-reduce orchestrator, so a very large questionnaire
could truncate — fine for test/demo content; use the admin streaming UI for big real ones.)

Two callers:

- **Backfill script** — `scripts/migrations/2026-06-13-backfill-data-slots.ts`
  (`npm run db:backfill:data-slots`). Finds every version with ≥1 question and 0 live slots and
  backfills each; idempotent (skips versions that already have slots; `--force` regenerates).
  Flags: `--dry-run`, `--force`, `--version=<id>`, `--questionnaire=<id>`, `--granularity=<level>`.
  Per-version fail-soft — one broken version never aborts the batch. Needs an LLM provider
  configured. WARNS if the data-slots flag is off (backfilled slots stay dormant until it's on).
- **Demo seed** — `prisma/seeds/app-questionnaire/025-demo-content.ts` calls it once **after** its
  transaction commits (an LLM call must not run inside a DB transaction), so a fresh
  `LOAD_DEMO_CONTENT=1` seed produces a demo that already has slots. Fail-soft: with no provider it
  logs a warning and leaves the demo usable without slots; re-seed or run the backfill script later.

## Runtime: the data-slot conversation (`runDataSlotTurn`)

Data-slot mode is active when the flag is on AND the version has ≥1 data slot. The `/messages`
route then drives `runDataSlotTurn` (`orchestrator/data-slot-orchestrator.ts`) instead of `runTurn`:

1. **Combined extraction (re-scan + enrich)** — the F4.2 extractor, given `dataSlotCandidates`
   (each carrying its `current` fill), returns BOTH the background question answers AND
   `dataSlotFills` in ONE call. The prompt tells it to **re-scan every slot each turn**, not just
   the active one: when a new answer adds context to any slot that already has a `current` value
   (even another theme), it emits an updated fill whose value+paraphrase is a **superset** of the
   prior one — so the panel summaries keep sharpening as the conversation accrues, instead of going
   stale.
2. **Targeting (topic-local)** — pick the next unfilled data slot, preferring the **current theme**
   (linger before moving on); transition to a new theme when the area is exhausted. The targeted
   slot feeds the **interviewer phraser** (`question-stream.ts`): deepen (same area), bridge
   (transition), or — on a re-ask — ask a **sharper, narrower** follow-up using the slot's current
   paraphrase (`currentUnderstanding`) rather than repeating the same open question.
3. **Move on / park (anti-repetition)** — a slot is only asked about `config.maxDataSlotAttempts`
   times (default 2 = ask once, one sharper re-ask). The per-turn re-ask count comes from
   `AppQuestionnaireTurn.targetedDataSlotId` (a consecutive leading-run, computed in
   `turn-context.ts` → `TurnState.dataSlotAttempts`). When the cap is hit and the slot is still
   below `DATA_SLOT_FILLED_THRESHOLD`, the route flags the candidate `parkPending` so the extractor
   makes a **best-effort low-confidence inference**, and the orchestrator **parks** it: marks that
   fill `provisional` (synthesising a floor fill if the model returned none), excludes it from
   targeting, and **bridges to a different theme**. So the respondent always moves forward instead
   of being asked the same thing repeatedly. A provisional slot counts as covered; a later
   confident answer **promotes** it (clears `provisional` via the upsert's shared write).
   The seriousness gate still runs first — a disregarded (abusive) turn never parks or records a
   provisional fill.
4. **Late-stage sweep** — once every data slot is covered, ask any still-unanswered **questions**
   directly.
5. **Completion** — offer to submit only when **all questions** are answered. The respondent
   progress bar + panel header track question completion (`answeredCount / total`), via a
   data-slot-mode override in `loadSessionStatus`.

Persistence: `persistTurn` upserts the data-slot fills (`upsertDataSlotFill`, carrying
`provisional`) alongside the question answers; `recordTurn` back-stamps
`AppQuestionnaireTurn.sideEffectDataSlotIds` and stores `targetedDataSlotId` (the unambiguous park
counter). The generic `targetedQuestionId` column ALSO carries the targeted data-slot id on a
data-slot turn (the loader resolves it to the active data slot for re-ask/transition next turn).

> Contradiction/refinement (F4.3/F4.4) are not run in data-slot mode v1 — the combined extractor
> improves fills/answers each turn. Active re-targeting of parked slots (vs the passive cross-turn
> enrichment above) is future work.

## Respondent panel

`GET …/:id/answers` returns themed `dataSlotGroups` (name + paraphrase + **provenance** + confidence

- filled + `provisional`) in data-slot mode; `AnswerSlotPanel` renders them grouped by theme. A
  parked slot shows its inferred summary with a subtle **"provisional · may revisit"** marker and
  counts toward the blended progress. The question rows are suppressed — the respondent only ever sees
  the abstraction layer.

**Inferred vs stated (honesty in the panel).** A fill carries the extractor's `provenance` — `direct`
(stated), `inferred` (single-step reasoning), or `synthesised` (across turns). The panel flags
`inferred`/`synthesised` fills with an **"Inferred · {confidence band}"** pill (e.g. _Inferred ·
unsure_) so a tentative reading is never mistaken for something the respondent said. Two prompt rules
keep these honest: (1) an inferred paraphrase must be **hedged** ("may", "seems") and never asserted
as fact; (2) a loose inference from a brief/vague message must carry **low confidence (≤ 0.4)**.
Low-confidence inferences stay **visible** (labelled), so the respondent can see — and correct — what
we're guessing. The extractor must **never record absence** ("tenure not provided"): a slot the
message doesn't bear on is simply **omitted**, and the panel shows "Not covered yet" on its own.

## Key files

| Concern                                  | Path                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models                                   | `prisma/schema/app-questionnaire.prisma` (`AppDataSlot`, `AppDataSlotQuestion`, `AppDataSlotFill.provisional`, `AppQuestionnaireTurn.targetedDataSlotId`, `AppQuestionnaireConfig.maxDataSlotAttempts`)                          |
| Domain (pure)                            | `lib/app/questionnaire/data-slots/**` (views, schemas, generation prompt, `assignment.ts` merge)                                                                                                                                 |
| Generator / refiner / assigner           | `lib/app/questionnaire/capabilities/generate-data-slots.ts`, `refine-data-slot.ts`, `assign-data-slots.ts`                                                                                                                       |
| Generate / refine / assign / CRUD routes | `app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/**` (`generate`, `generate/stream`, `refine`, `assign`, `draft`)                                                                                                   |
| Admin review UI                          | `app/admin/questionnaires/[id]/data-slots/page.tsx`, `components/admin/questionnaires/data-slots-review.tsx`, `data-slot-refine-button.tsx`; assign checkbox in `evaluation-finding-review.tsx` + `evaluation-seed-composer.tsx` |
| Engine                                   | `orchestrator/data-slot-orchestrator.ts`, `extraction/**` (combined), `_lib/turn-context.ts`, `_lib/data-slot-fills.ts`                                                                                                          |
| Respondent panel                         | `_lib/answer-panel.ts`, `components/app/questionnaire/panel/answer-slot-panel.tsx`                                                                                                                                               |
| Seeds                                    | `prisma/seeds/app-questionnaire/028-032` (031 = refine capability row, 032 = assign capability row, both bound to the generator agent)                                                                                           |
