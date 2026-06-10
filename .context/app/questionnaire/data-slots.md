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

## Admin: generate → review → launch gate

1. After questions are extracted + approved, the version detail page shows **Data slots** (draft +
   launched). It links to `/admin/questionnaires/:id/data-slots`.
2. **Generate** dispatches `app_generate_data_slots` (the `app-questionnaire-data-slots-generator`
   agent) over the version's questions → proposed slots (name + description + theme + question
   mappings). Read-only preview — `POST …/versions/:vid/data-slots/generate` persists nothing.
3. The admin reviews/edits/accepts each slot, then **Save** (`PUT …/versions/:vid/data-slots`)
   replaces the version's slots (fork-safe). `theme` is the generator's grouping label.
4. **Launch gate:** when the flag is on, "Data slots generated" is a launch-checklist item
   (client `LaunchChecklist` + server `assertLaunchable`), so every launched questionnaire runs in
   data-slot mode.

## Runtime: the data-slot conversation (`runDataSlotTurn`)

Data-slot mode is active when the flag is on AND the version has ≥1 data slot. The `/messages`
route then drives `runDataSlotTurn` (`orchestrator/data-slot-orchestrator.ts`) instead of `runTurn`:

1. **Combined extraction** — the F4.2 extractor, given `dataSlotCandidates`, returns BOTH the
   background question answers AND `dataSlotFills` (a paraphrase + confidence per informed slot) in
   ONE call.
2. **Targeting (topic-local)** — pick the next unfilled data slot, preferring the **current theme**
   (linger in an area before moving on); only transition to a new theme when the area is exhausted.
   The targeted slot's name+description feed the **interviewer phraser** (`question-stream.ts`),
   which acknowledges the prior answer and either deepens (same area) or bridges (transition), with
   re-ask framing when a slot's fill wasn't captured.
3. **Late-stage sweep** — once every data slot is filled (confidence ≥ `DATA_SLOT_FILLED_THRESHOLD`),
   ask any still-unanswered **questions** directly.
4. **Completion** — offer to submit only when **all questions** are answered. The respondent
   progress bar + panel header track question completion (`answeredCount / total`), via a
   data-slot-mode override in `loadSessionStatus`.

Persistence: `persistTurn` upserts the data-slot fills (`upsertDataSlotFill`) alongside the question
answers; `recordTurn` back-stamps `AppQuestionnaireTurn.sideEffectDataSlotIds`. The generic
`targetedQuestionId` column carries the targeted **data-slot id** on a data-slot turn (the loader
resolves it to the active data slot for re-ask/transition next turn).

> Contradiction/refinement (F4.3/F4.4) are not run in data-slot mode v1 — the combined extractor
> improves fills/answers each turn. Reconciliation over data slots is future work.

## Respondent panel

`GET …/:id/answers` returns themed `dataSlotGroups` (name + paraphrase + confidence + filled) in
data-slot mode; `AnswerSlotPanel` renders them grouped by theme. The question rows are suppressed —
the respondent only ever sees the abstraction layer.

## Key files

| Concern                | Path                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Models                 | `prisma/schema/app-questionnaire.prisma` (`AppDataSlot`, `AppDataSlotQuestion`, `AppDataSlotFill`)                      |
| Domain (pure)          | `lib/app/questionnaire/data-slots/**` (views, schemas, generation prompt)                                               |
| Generator capability   | `lib/app/questionnaire/capabilities/generate-data-slots.ts`                                                             |
| Generate / CRUD routes | `app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/**`                                                       |
| Admin review UI        | `app/admin/questionnaires/[id]/data-slots/page.tsx`, `components/admin/questionnaires/data-slots-review.tsx`            |
| Engine                 | `orchestrator/data-slot-orchestrator.ts`, `extraction/**` (combined), `_lib/turn-context.ts`, `_lib/data-slot-fills.ts` |
| Respondent panel       | `_lib/answer-panel.ts`, `components/app/questionnaire/panel/answer-slot-panel.tsx`                                      |
| Seeds                  | `prisma/seeds/app-questionnaire/028-030`                                                                                |
