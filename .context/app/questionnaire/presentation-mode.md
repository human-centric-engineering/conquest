# Presentation mode (chat / form / both)

`presentationMode` is the per-version config knob (`AppQuestionnaireConfig`,
`PRESENTATION_MODES = chat | form | both`, default `chat`) that chooses how a
respondent completes a session:

- **chat** — the streaming conversation (the original surface, incl. the data-slots
  experience). Unchanged from before this feature.
- **form** — the questionnaire as a raw, sectioned form: each question rendered with
  the right control for its type (likert with configurable bounds incl. negatives,
  free text, single/multi choice, yes/no, numeric, date), with a completeness map and
  prev/next section navigation.
- **both** — the respondent toggles between chat and form mid-session. The form
  doubles as an **escape hatch** when the chat struggles to fill a slot, and lets the
  respondent see and edit answers the agent inferred in the background.

Available in admin **preview** (`/q/[versionId]?preview=1`) and real respondent modes
(authenticated `[sessionId]`, anonymous/no-login `/q/[versionId]`) alike — the surface
flows through the same `SessionWorkspace`.

## Where it's wired

| Concern             | Location                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config field + enum | `lib/app/questionnaire/types.ts` (`PRESENTATION_MODES`, `QuestionnaireConfigShape.presentationMode`, default `chat`)                                 |
| Zod (PATCH)         | `lib/app/questionnaire/authoring/config-schema.ts`                                                                                                   |
| Schema column       | `AppQuestionnaireConfig.presentationMode` (migration `…_add_presentation_mode_and_respondent_edited`)                                                |
| Read projection     | `app/api/v1/app/questionnaires/_lib/detail.ts` (`toConfigView`)                                                                                      |
| Admin control       | `components/admin/questionnaires/config-editor.tsx` (Presentation mode `<Select>`), surfaced on the **Settings** tab via `config-settings-panel.tsx` |
| Mode dispatch       | `components/app/questionnaire/session-workspace.tsx` (three-way render + the `both` toggle)                                                          |
| Server pages        | `app/(protected)/questionnaires/[sessionId]/page.tsx`, `app/(public)/q/[versionId]/page.tsx` (resolve mode, seed the form view)                      |

## The raw form surface

- **Components** live in `components/app/questionnaire/form/`: `QuestionnaireForm`
  (container), `SectionNavigator` (completeness map), `QuestionField` (per-type
  dispatcher), plus the app-local `RadioGroup` and `LikertScale` primitives (the
  platform has neither). typeConfig is read through
  `lib/app/questionnaire/form/type-config.ts` — the same authoring schemas the server
  validator uses, so the control matches exactly what the server accepts.
- **State + autosave**: `lib/hooks/use-form-answers.ts`. Each edit persists to
  `AppAnswerSlot` immediately (debounced ~400ms, with a blur flush), so a chat turn
  sees the respondent's own answer next turn. Empty values persist as a CLEAR (row
  delete). Local input values stay authoritative across save round-trips; the returned
  view refreshes the completeness map + provenance. `refresh()` re-seeds from a fresh
  GET on entering the form (so chat-inferred answers appear); `enabled: false` keeps
  the hook inert in chat-only mode.

## Read model: `?view=form`

`GET …/questionnaire-sessions/:id/answers?view=form` returns the FULL question
structure (every question + its `typeConfig`, answered or not) **regardless of
`answerSlotPanelScope`**, and never the data-slot abstraction. `answerSlotPanelScope`
remains a _chat-panel_ setting (it may still hide pending prompts there); the form is
inherently full-structure. `PanelSlotView` carries `typeConfig` for this. Implemented
by the `forForm` flag on `loadAnswerPanelState`.

## Write API + edit-vs-fresh recording

`PUT …/questionnaire-sessions/:id/answers` with `{ answers: [{ questionKey, value?,
clear? }] }`. Same access as the turn route (`resolveTurnAccess` — authed owner OR
anonymous/preview `X-Session-Token`); **active-status only** (409 otherwise); each
value validated against its question's type/typeConfig via `validateAnswerValue`
before any write (a malformed value rejects the whole batch — no partial writes);
persisted in one transaction; returns the refreshed form view.

Recording (seam: `app/api/v1/app/questionnaire-sessions/_lib/form-answers.ts`):

- **Fresh** (no row) → create with provenance `direct`, confidence 1, no history.
  Absence of any history entry = answered fresh.
- **Edit** (row exists, value changes) → append one `RefinementHistoryEntry` with
  `source: 'manual'` (preserving the prior value + provenance), set provenance
  `refined`. A `manual` entry whose `previousProvenance` is `inferred`/`synthesised`
  is the record that the respondent **adjusted an agent-inferred answer**.

Both set `AppAnswerSlot.respondentEdited = true`.

## Protection: respondent edits are authoritative

A respondent's own form answer must not be silently overwritten by later chat-turn
extraction/refinement. `respondentEdited` is the cheap guard: `persistTurn`
(`turn-run.ts`) loads `loadRespondentEditedSlotIds(sessionId)` and skips any
extraction/refinement write targeting an edited slot. Contradiction _detection_ still
runs (it's a read on its own warning channel) — only the silent overwrite is suppressed.

## Data slots (immediate reconciliation)

The form is always **question-based** (edits `AppAnswerSlot`), even when the data-slots
feature is on — the `?view=form` path keeps question sections and never swaps in the
data-slot groups. When data slots are enabled, a form write also **reconciles the
chat-facing data-slot fills in the same transaction** (`reconcileDataSlotFills`): for each
data slot that maps (via `AppDataSlotQuestion`) to an edited question, it recomputes the
fill from the session's current answers to all the slot's mapped questions —

- some answered → upsert the `AppDataSlotFill` with a deterministic paraphrase (the
  answered values, joined), `direct` provenance, full confidence, non-provisional;
- none answered (all cleared) → delete the fill, reverting the slot to "not covered yet".

So a form edit shows up in the chat data-slot panel immediately, not just on the next turn.
The paraphrase is deterministic (no LLM); a later chat turn may re-paraphrase it. Note the
data-slot fill itself is not protected from a subsequent chat-turn overwrite (only the
underlying `AppAnswerSlot` carries `respondentEdited`); fill-level protection is a possible
follow-up.

## Gating

No dedicated feature flag — the whole respondent surface (pages, answers GET/PUT,
messages, lifecycle) already sits behind `APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG`, and
form mode adds no LLM spend. `presentationMode` is the per-questionnaire opt-in.
