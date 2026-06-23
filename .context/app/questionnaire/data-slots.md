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

**The two layers hold two representations of the same answer, and must not be conflated.** The
data-slot fill records the respondent's answer in their **natural words** — "Marketing", "10 years"
— because the panel shows it back to them and must read like the conversation. The answer slot
records the **mapped form value** — the choice slug `other`, the tenure bucket `gt3` — because that
is the deliverable. The extractor emits BOTH in one call (`answers` = mapped slugs, `dataSlotFills`
= natural values); the mapping from natural → slug runs in the background and is never surfaced. So
keeping a data slot fresh on a correction (engineering → Marketing) is primarily the extractor's
job — we don't blindly recompute every fill from its form values, because that would leak the form
code/label into the natural panel.

There is ONE deterministic safety net on the chat path: a **gap-filler**
(`reconcileChatDataSlotFills`, `data-slot-fills.ts`). The extractor can answer a mapped question
while leaving its PARENT slot empty (a generation miss the prompt asks it to avoid but can't
guarantee — e.g. "badly thought out KPIs" answers `performance_kpis` but its slot `business_execution`
stays blank). After the per-turn answer writes, the gap-filler synthesises a fill for any slot whose
mapped question was answered this turn but which has **no fill yet** — it skips any slot that already
has one (the extractor's just-written fills included), so it never overwrites a richer paraphrase or a
prior respondent-stated `direct` capture; evolving a non-empty slot stays the extractor's job. To
avoid the form-code leak, the
synthesised paraphrase **leads with the answer's stored `rationale`** (already natural language),
falling back to the formatted value only when there is none; provenance is `inferred` (one mapped
question) or `synthesised` (several), never `direct`. Each gap-fill is logged (an invariant breach
worth tracking). This mirrors the reverse direction — a form edit recomputing its mapped slots —
which lives in `reconcileDataSlotFills` (`form-answers.ts`).

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

   **Forward propagation (slot fill → mapped question answer).** Each candidate carries its
   `mappedQuestionKeys` — the question(s) the `AppDataSlotQuestion` mapping says it captures, loaded
   in `turn-context.ts` and threaded all the way to the prompt (rendered as an `answers questions:`
   line on the slot). The prompt makes the contract explicit: **whenever the extractor emits a fill
   for a mapped slot, it must ALSO emit an `answers` entry for each mapped question the captured
   position determines**, translating the qualitative position onto that question's own
   type/scale/options (e.g. "I hate my job" → the bottom of a 1–5 satisfaction scale). These answers
   use provenance `inferred`/`synthesised` (never `direct` — the respondent didn't state the typed
   value). **This provenance is judged independently of the data-slot FILL** (the contract fix the
   eval guards): the FILL can be `direct` (they plainly stated their stance) while the mapped ANSWER
   is `inferred` (they didn't state the number) — the prompt no longer lets the scale mapping drag
   the fill's provenance to `inferred`, which was what mislabelled "extremely unlikely" as an
   inference. Confidence is scored as **clarity** (how plainly the position is expressed), in coarse
   bands (`clear`/`partial`/`unclear`), with corroboration only ever nudging a clear answer _up_ over
   turns — never dragging a clearly-stated first answer down. A firmly-pinned mapped value is `clear`
   even when its provenance is `inferred`. An **appropriateness gate** keeps it from guessing: if the message
   informs the slot but doesn't pin down a particular question's value, that question is **omitted**
   rather than invented. The extractor — not a separate agent — is the judge here, since it already
   sees the message, the captured position, and the mapped question's definition in one call. The
   answers flow through the normal `normalizeAnswerIntents → upsertAnswerSlot` path, so they stay
   **updatable**: later corroboration raises confidence, a contradiction corrects the value, and a
   respondent's own form edit (the `respondentEdited` lock) freezes them. Without this, a slot could
   fill at high confidence while its form question stayed empty — the panel moved but the deliverable
   didn't. (The reverse direction — a form edit recomputing its mapped slots — lives in
   `form-answers.ts`.)

2. **Targeting (topic-local, or adaptive)** — pick the next unfilled data slot, preferring the
   **current theme** (linger before moving on); transition to a new theme when the area is exhausted.
   This deterministic `pickNextDataSlot` is the default. When **adaptive data-slot selection** is on
   (see below), an embedding-ranked LLM selector chooses the next slot instead — fail-soft back to
   the deterministic pick. The targeted slot feeds the **interviewer phraser** (`question-stream.ts`):
   deepen (same area), bridge (transition), or — on a re-ask — ask a **sharper, narrower** follow-up
   using the slot's current paraphrase (`currentUnderstanding`) rather than repeating the same open
   question.
   **Coverage is provenance-aware, not confidence-only.** A slot counts as _covered_ (so it is
   neither re-asked nor parked) when the respondent plainly **stated** a position (`provenance:
'direct'`) OR the fill cleared `DATA_SLOT_FILLED_THRESHOLD` OR it was already parked
   (`provisional`) — see `isCovered`. The `direct` clause is deliberate: a clearly-stated answer is
   answered even when the extractor under-scores its confidence number, so a noisy score can never
   make a real answer read as missing. (This was a live bug: a blunt "extremely unlikely" was scored
   `inferred · 0.40`, fell below the threshold, got re-asked to the cap, and was parked
   `provisional · may revisit` — a clear answer mislabelled a guess.) Provenance is threaded through
   the loader (`turn-context.ts`), so a direct fill stays covered across turns regardless of its
   stored confidence.

3. **Move on / park (anti-repetition)** — a slot is only asked about `config.maxDataSlotAttempts`
   times (default 2 = ask once, one sharper re-ask). The per-turn re-ask count comes from
   `AppQuestionnaireTurn.targetedDataSlotId` (a consecutive leading-run, computed in
   `turn-context.ts` → `TurnState.dataSlotAttempts`). When the cap is hit and the slot is still
   uncovered (per the rule above — a `direct` fill is never parked), the route flags the candidate
   `parkPending` so the extractor makes a **best-effort low-confidence inference**, and the
   orchestrator **parks** it: marks that fill `provisional` (synthesising a floor fill if the model
   returned none), excludes it from targeting, and **bridges to a different theme**. So the
   respondent always moves forward instead of being asked the same thing repeatedly. A provisional
   slot counts as covered; a later confident answer **promotes** it (clears `provisional` via the
   upsert's shared write). The seriousness gate still runs first — a disregarded (abusive) turn
   never parks or records a provisional fill.
4. **Late-stage sweep** — once every data slot is covered, ask any still-unanswered **questions**
   directly.
5. **Completion** — offer to submit only when **all questions** are answered (a data-slot-mode
   submit-gate override in `loadSessionStatus`, independent of the configurable weighted
   threshold). Progress, by contrast, is one figure everywhere: the respondent top progress bar,
   the panel's "What we're learning" header, and the chat reasoning trace's "X% covered so far"
   all show the **weighted question coverage** (`coverageRatio` / `weightedCoverage`) — guided by
   question completeness, never moved by how many data slots are filled, so the three can't
   disagree.

Persistence: `persistTurn` upserts the data-slot fills (`upsertDataSlotFill`, carrying
`provisional`) alongside the question answers; `recordTurn` back-stamps
`AppQuestionnaireTurn.sideEffectDataSlotIds` and stores `targetedDataSlotId` (the unambiguous park
counter). The generic `targetedQuestionId` column ALSO carries the targeted data-slot id on a
data-slot turn (the loader resolves it to the active data slot for re-ask/transition next turn).

**Contradiction detection + refinement (F4.3/F4.4) run in data-slot mode** (parity with question
mode) via the shared `runContradictionPhase`: gated by the questionnaire's `contradictionMode` +
`contradictionEveryNTurns` cadence and the platform flag, with a ≥1-stored-answer floor (a single
answer can contradict the latest message; ≥2 only when there's no message). They compare the **background question answers** — and, crucially, the respondent's
**latest message** (`currentStatement`) — so a _same-slot reversal_ across turns ("I hate the job"
→ "I love my job") is caught even when extraction didn't overwrite the stored answer. Under `flag`
mode it surfaces an informational notice and refines immediately; under `probe` mode it runs the
[confirm-before-overwrite flow](./contradiction-detection.md#probe-confirm-flow-probe-mode) — the
interviewer asks a reconciliation question and **suppresses this turn's data-slot fills + answers**
until the respondent confirms next turn (the parked finding lives on
`AppQuestionnaireSession.pendingContradiction`). Active re-targeting of parked slots (vs the passive
cross-turn enrichment above) is future work.

## Adaptive data-slot selection (50+-slot scale)

The deterministic topic-local pick is fine for a handful of slots, but at **50+ data slots** it
can't tell which unfilled slot flows most naturally from what the respondent just said. Adaptive
data-slot selection is the data-slot analogue of [adaptive question selection](selection-strategies.md):
it ranks the unfilled slots by **embedding similarity** to the last message (pgvector, same model as
question slots) and asks the seeded **selector agent** which to pursue next.

- **Embeddings.** `AppDataSlot.embedding` is a `vector(1536)` pgvector column (the data-slot analogue
  of `AppQuestionSlot.embedding`), embedded over `name` + `description`. Raw-SQL read/write in
  `_lib/data-slot-embeddings.ts` (`embedVersionDataSlots`, `rankDataSlotsByVector`,
  `dataSlotEmbeddingCoverage`, `ensureVersionDataSlotsEmbedded`); HNSW index added by raw SQL in the
  migration. Same drift-warning discipline as the question-slot column.
- **Candidate set (preserves the theme rhythm).** The pre-filter narrows the unfilled pool to the
  top-K by similarity, but **always keeps a couple of same-theme slots** so the topic-local "linger"
  is still available, and **biases away from a just-parked theme** when bridging. The selector agent
  sees that set (with themes) and is told to follow where the respondent is steering — a clearly
  volunteered topic outweighs finishing the current area — but otherwise prefer continuity over raw
  jumps. So embeddings refine the rhythm rather than replacing it.
- **The seam.** Pure orchestrator → `selectDataSlot` invoker (optional, on `CapabilityInvokers`) →
  `_lib/data-slot-selection.ts` (`selectNextDataSlot`). **Fail-soft everywhere**: no last message,
  <2 candidates, un-embedded slots, a selector error, or an off-pool pick all return `null` and the
  orchestrator falls back to `pickNextDataSlot`. The selector's spend is folded into the turn cost.
- **Anonymous + preview sessions run the LLM pick too.** The selector agent runs as a **direct
  structured completion** (`runSelectorCompletion`, `_lib/selector-completion.ts`) — the same
  mechanism the seriousness/sensitivity judges use — so it persists **no** `AiConversation` and has no
  `user` FK to violate. It therefore works identically for authenticated, anonymous (no-login,
  synthetic `anon:<sessionId>` user), and admin-preview (null `respondentUserId`) sessions. (It used
  to run through `drainStreamChat`, which writes a conversation keyed to a real `user` — that insert
  FK-violated on the synthetic anonymous user, so both selectors skipped the LLM pick for anonymous
  sessions and silently fell back to the deterministic order. That short-circuit is gone.) The
  `anonymous` flag still threads from `resolveTurnAccess` → `/messages` → `buildTurnInvokers` for
  caller compatibility but **no longer gates** selection.
- **Gating.** Sub-flag `APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_ENABLED`
  (`isAdaptiveDataSlotSelectionEnabled` = master AND data-slots AND live-sessions AND this sub-flag),
  off by default. The `/messages` route wires the invoker only in data-slot mode with the flag on,
  and lazily ensures the slots are embedded the first time such a session runs (cheap no-op once
  embedded; fail-soft).
- **Admin surfaces.** The **Data slots tab** shows an explicit "Generate embeddings" step + coverage
  when the feature is on (`GET/POST …/versions/:vid/embed-data-slots`). The **Review & Launch**
  checklist adds a "Data slots embedded for adaptive selection" check — required when the feature is
  on AND the version has data slots, **launch-only** (the preview gate opts out; the lazy backstop
  covers rehearsal). Mirrors the question-slot embedding operability.

### Deepen a volunteered tangent (be led by the respondent)

A respondent often volunteers a **strong opinion about something we weren't asking about** — "our
KPIs are useless", "the CRM is a mess" — mid-answer or on a tangent. The extractor is told to
**capture that signal anyway** (the "VOLUNTEERED TOPICS" rule in `extraction-prompt.ts`: when a
message bears a clear, strongly-voiced opinion about a specific named subject, fill the slot for
**that** subject even when it isn't the active topic, pinning the matching question's pole). But once
that off-topic slot is filled it **drops out of `unfilled`**, so the interviewer would never follow
up on the very thing the respondent is animated about — the **capture-and-drop gap**.

`runDataSlotTurn` closes it. Each turn it computes **deepen candidates**: slots that got a `direct`,
non-provisional fill **this turn** on a key **other than** the active slot (i.e. a just-volunteered
tangent that is now covered). These are prepended to the selector's `candidatePool` (ahead of
`unfilled`) so the selector **can choose to go a little deeper** — and the seeded selector prompt now
leads with "FOLLOW WHERE THE RESPONDENT IS STEERING": a clearly volunteered topic outweighs finishing
the current area and the listed order. A deepen pick is framed as a **follow-up** (`isReask`, never
`isTransition`) with the rationale _"Following up on what they raised about {name} before moving
on."_ It is **bounded to deepen once**: once targeted, that slot becomes the active slot next turn, so
it no longer qualifies as a non-active tangent — the conversation deepens once, then moves on. When
the adaptive selector is off (or returns no pick), the deterministic `pickNextDataSlot` runs over
`unfilled` only, so deepen has no effect — it is purely an adaptive-selection enrichment.

## Respondent panel

`GET …/:id/answers` returns themed `dataSlotGroups` (name + paraphrase + **provenance** + confidence

- filled + `provisional`) in data-slot mode; `AnswerSlotPanel` renders them grouped by theme. A
  parked slot shows its inferred summary with a subtle **"provisional · may revisit"** marker. The
  panel's "% complete" header tracks the **weighted question coverage** (not data-slot fills — those
  are the abstraction layer, not the deliverable), so it matches the reasoning trace and the top
  progress bar exactly. The question rows are suppressed — the respondent only ever sees the
  abstraction layer.

**Inferred vs stated (honesty in the panel).** A fill carries the extractor's `provenance` — `direct`
(stated), `inferred` (single-step reasoning), or `synthesised` (across turns). The panel flags
`inferred`/`synthesised` fills with an **"Inferred · {confidence band}"** pill (e.g. _Inferred ·
unsure_) so a tentative reading is never mistaken for something the respondent said. Two prompt rules
keep these honest: (1) an inferred paraphrase must be **hedged** ("may", "seems") and never asserted
as fact; (2) a loose, tangential inference from a brief/vague message must carry **low confidence
(0.3–0.45)**. The confidence rubric is **finer** than the old three bands: it spans **0.3–1.0** keyed
on directness × elaboration × certainty — a directly-stated position backed by a reason/example ≈
0.9–1.0, a clear bare statement ≈ 0.75–0.85, a terse/vague answer ≈ 0.45–0.6, a tangential inference
≈ 0.3–0.45 (the panel labels these "Confident / Fairly sure / Tentative / Unsure"). Low-confidence
inferences stay **visible** (labelled), so the respondent can see — and correct — what we're guessing.

**Low confidence biases the next question toward deepening.** A sub-threshold inferred/synthesised
fill stays uncovered → eligible to re-target, and the adaptive selector is told which candidates sit
in a shaky (low-confidence) area so it can choose to **probe deeper** there rather than move on (the
weighted scorer already pulls back to such sections; `LOW_CONFIDENCE_THRESHOLD` is 0.6). The phraser
then names _why_ it's circling back ("Earlier you mentioned …, and I want to make sure I follow…").
A confidently-captured area is left alone. How hard a shaky answer is probed before it's parked is the
admin's `maxDataSlotAttempts` (Settings tab). The extractor must **never record absence** ("tenure not provided"): a slot the
message doesn't bear on is simply **omitted**, and the panel shows "Not covered yet" on its own.

**Rationale = the evidence ("Why?").** The fill's `rationale` (the panel's _Why?_ expander) must carry
the actual substance — _what the respondent was asked and what they said_ — framed "When asked about
&lt;topic&gt;, the respondent said …", so reading paraphrase + rationale lands a reviewer on the **same
conclusion** they'd reach from the chat. A bare meta-statement ("Their statement about X informs this
topic.") is forbidden — it tells the reader nothing. The substance may be paraphrased but must uphold
the meaning expressed in the conversation. Subject wording stays **gender-neutral and varied** ("the
respondent" / "they" / "this person"), never assuming a gender — this applies to the paraphrase too.

## Key files

| Concern                                  | Path                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models                                   | `prisma/schema/app-questionnaire.prisma` (`AppDataSlot`, `AppDataSlotQuestion`, `AppDataSlotFill.provisional`, `AppQuestionnaireTurn.targetedDataSlotId`, `AppQuestionnaireConfig.maxDataSlotAttempts`)                          |
| Domain (pure)                            | `lib/app/questionnaire/data-slots/**` (views, schemas, generation prompt, `assignment.ts` merge)                                                                                                                                 |
| Generator / refiner / assigner           | `lib/app/questionnaire/capabilities/generate-data-slots.ts`, `refine-data-slot.ts`, `assign-data-slots.ts`                                                                                                                       |
| Generate / refine / assign / CRUD routes | `app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/**` (`generate`, `generate/stream`, `refine`, `assign`, `draft`)                                                                                                   |
| Admin review UI                          | `app/admin/questionnaires/[id]/data-slots/page.tsx`, `components/admin/questionnaires/data-slots-review.tsx`, `data-slot-refine-button.tsx`; assign checkbox in `evaluation-finding-review.tsx` + `evaluation-seed-composer.tsx` |
| Engine                                   | `orchestrator/data-slot-orchestrator.ts`, `extraction/**` (combined), `_lib/turn-context.ts`, `_lib/data-slot-fills.ts`                                                                                                          |
| Adaptive selection                       | `_lib/data-slot-embeddings.ts` (pgvector seam), `questionnaire-sessions/_lib/data-slot-selection.ts` (selector), `embed-data-slots/route.ts` (generate/coverage), `components/admin/questionnaires/data-slot-embedding-step.tsx` |
| Respondent panel                         | `_lib/answer-panel.ts`, `components/app/questionnaire/panel/answer-slot-panel.tsx`                                                                                                                                               |
| Calibration eval                         | `lib/app/questionnaire/extraction/eval/**` (golden set + pure scorer), `scripts/eval/extraction.ts` (`npm run eval:extraction`)                                                                                                  |
| Seeds                                    | `prisma/seeds/app-questionnaire/028-032` (031 = refine capability row, 032 = assign capability row, both bound to the generator agent)                                                                                           |

### Calibration eval (golden set)

Extraction's `confidence`/`provenance` judgements were being tuned by anecdote — one prompt clause
per bug report, never measured — so a fix for one case could silently regress another. The golden
set (`extraction/eval/golden-set.ts`) is a small hand-labelled corpus of real-shaped extraction
turns annotated with what a correctly-calibrated extractor should return, scored on three axes by
the pure `score.ts`: **provenance** (a STATED answer must be `direct`, not `inferred`), **band** (a
clear answer must land in the `clear` confidence band, not be under-scored), and **covered** (the
downstream consequence — would it be re-asked/parked?). Confidence is scored as a **coarse band**
(`clear` ≥ 0.7 / `partial` ≥ 0.45 / `unclear`), never an exact float — an LLM-emitted confidence is
not calibrated to the finer rubric's resolution. The `partial` cut sits at the rubric's
terse(0.45–0.6) / tangential(0.3–0.45) seam, so the eval distinguishes "worth deepening" from
"barely there"; the corpus now includes a terse-but-complete closed answer (clear), a terse
qualitative answer (partial), and a tangential inference (unclear, `knownGap`). `npm run eval:extraction` runs the live `chat`-tier model over
the set and prints a scorecard; run it before and after any prompt/model change. Fixtures flagged
`knownGap` are cases the current prompt is expected to fail (the calibration target) and are
reported apart from genuine regressions. The scorer + corpus are unit-tested (CI-safe, no LLM);
only the runner needs provider keys.
