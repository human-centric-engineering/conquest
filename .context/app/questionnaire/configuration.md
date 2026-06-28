# Questionnaire — configuration

> The per-version run-time configuration an admin authors before launch, and the
> launch gate that decides when a version may go live. Built by **F3.1**
> ([`../planning/features/f3.1.md`](../planning/features/f3.1.md)) — the first
> feature of P3. Gated by `APP_QUESTIONNAIRES_ENABLED` (seeded off). Builds on the
> F2.1 scoped-version + fork-on-launched seams.

## What it does

F2.1–F2.4 author a questionnaire's _content_ (goal, audience, sections, questions,
tags); F3.1 adds everything about _how a session runs_. An admin sets the question
selection strategy, completion thresholds, a cost budget and per-session cap, the
voice / contradiction / anonymous modes, and the session-start profile fields
collected from each respondent. None of these are consumed yet — F3.1 only authors
and stores them; the consumers land later (see _Who consumes it_).

## The model

`AppQuestionnaireConfig` (`app_questionnaire_config`) — **1:1 with the version**
(`versionId @unique`, `onDelete: Cascade`), so it forks with the version exactly
like goal/audience and the section graph. One typed column per setting plus a
single JSON column for the profile fields:

| Setting                               | Column                     | Type                   | Default             |
| ------------------------------------- | -------------------------- | ---------------------- | ------------------- |
| Question selection strategy           | `selectionStrategy`        | String (enum)          | `'adaptive'`        |
| Completion: min questions             | `minQuestionsAnswered`     | Int                    | `0`                 |
| Completion: coverage threshold        | `coverageThreshold`        | Float (0–1)            | `1.0`               |
| Cost budget (USD / session)           | `costBudgetUsd`            | Float? (null = no cap) | `null`              |
| Per-session question cap              | `maxQuestionsPerSession`   | Int? (null = no cap)   | `null`              |
| Voice input                           | `voiceEnabled`             | Boolean                | `false`             |
| Contradiction-detection mode          | `contradictionMode`        | String (enum)          | `'off'`             |
| Contradiction look-back window N      | `contradictionWindowN`     | Int                    | `0`                 |
| Contradiction cadence (every N turns) | `contradictionEveryNTurns` | Int                    | `1`                 |
| Answer-fit resolver mode              | `answerFitMode`            | String (enum)          | `'fallback'`        |
| Anonymous mode (identity axis)        | `anonymousMode`            | Boolean                | `false`             |
| Access mode (who may start)           | `accessMode`               | String (enum)          | `'invitation_only'` |
| Invitee detail fields                 | `inviteeFields`            | Json (array)           | email + names       |
| Abuse threshold (seriousness gate)    | `abuseThreshold`           | Int (0 = off)          | `4`                 |
| Sensitivity awareness (safeguarding)  | `sensitivityAwareness`     | Boolean                | `false`             |
| Support message (signpost copy)       | `supportMessage`           | String (empty = off)   | `''`                |
| Support resource URL                  | `supportResourceUrl`       | String (URL)           | `''`                |
| Session-start profile fields          | `profileFields`            | Json (array)           | `[]`                |
| Answer panel scope                    | `answerSlotPanelScope`     | String (enum)          | `'full_progress'`   |
| Presentation mode                     | `presentationMode`         | String (enum)          | `'chat'`            |
| Inline answer correction              | `inlineCorrectionEnabled`  | Boolean                | `true`              |
| Interviewer tone & persona            | `tone`                     | Json (object)          | all dimensions off  |
| Respondent Report                     | `respondentReport`         | Json (object)          | disabled, raw mode  |

The enums are `const` tuples in `lib/app/questionnaire/types.ts` (single source of
truth — the Zod schema, the read-view narrowing, and the editor's `<Select>`
options all derive from them): `SELECTION_STRATEGIES`
(`sequential | weighted | adaptive`), `CONTRADICTION_MODES` (`off | flag | probe`),
`PROFILE_FIELD_TYPES` (`text | email | number | select`), `ANSWER_SLOT_PANEL_SCOPES`
(`full_progress | answered_only`), `PRESENTATION_MODES` (`chat | form | both`).

`answerSlotPanelScope` (F7.2) is read by the respondent answer-panel endpoint
(`GET …/questionnaire-sessions/:id/answers`), not the turn engine: `full_progress`
returns every slot grouped by section (an X-of-N progress view), `answered_only`
returns just the captured answers so the pending structure is never sent to the
client. See `.context/app/questionnaire/answer-slot-panel.md`.

`accessMode` and `anonymousMode` are **orthogonal axes**. `accessMode`
(`invitation_only` | `public` | `both`) is the _access_ axis — who may start a session;
the session-create gates (`createAnonymousSession` / `createSessionForVersion`) and the
public `/q/[versionId]` page dispatch on it (unconfigured versions default to
`invitation_only`). `anonymousMode` is the _identity_ axis — whether identifying profile
data is collected; it still drives the `AppRespondentProfileSnapshot` write-skip. A
questionnaire can be public + identified, or invitation-only + anonymous, in any
combination. Historically the two were conflated in `anonymousMode` (true ⇒ public); the
access-mode migration backfilled `accessMode` from it. `inviteeFields`
(`InviteeFieldConfig[]`) is the admin-configurable set of per-invitee detail fields the
Invitations surface captures — `email` is always shown + required; see
[invitations.md](./invitations.md).

`presentationMode` (F9.7) chooses how the respondent completes the session: `chat`
(the streaming conversation), `form` (a raw, sectioned form rendering each question
with the right input control), or `both` (a chat ↔ form toggle). It is read by the
respondent server pages (authenticated `[sessionId]` + public `/q/[versionId]`),
which dispatch the surface and seed the full form view for `form`/`both`. Defaults
to `chat` so existing launched versions are unchanged. See
`.context/app/questionnaire/presentation-mode.md`.

`inlineCorrectionEnabled` (Variant B) turns on the "fix this answer" gesture: the respondent
can correct an answer the latest turn just captured through a small inline editor — beneath the
most-recent message in the chat (the `CorrectionStrip`) and on the answer-panel rows — instead of
sending a corrective chat turn. The fix saves through the form-edit path (`PUT …/answers`), so it
**bypasses the turn pipeline entirely**: no extraction, no contradiction re-check (a corrective chat
turn would otherwise risk a false same-slot contradiction warning). In data-slot mode a fix edits the
slot's mapped questions and reconciliation recomputes the reading; a data slot with no mapped
questions shows no gesture. On by default — respondent-facing UX with **no platform flag** (unlike
voice/attachments/reasoning); the admin toggles it per version on the Settings tab. The respondent
pages resolve it (`resolveInlineCorrectionForVersion` / `loadSessionSurfaceConfig`) and pass it to
`SessionWorkspace`; the read-only admin session viewer never shows it. See
`.context/app/questionnaire/answer-slot-panel.md`.

`tone` (F-tone) is the interviewer's voice — a single JSON object (`ToneSettings`) of nine
enable-toggle + 1–5 sliders (empathy, mirroring, formality, mimicry, verbosity, warmth, curiosity,
reading complexity, humour) plus a free-text `persona`. Each dimension is off by default, so the
default block changes nothing. The live phraser renders the **enabled** dimensions into its system
prompt; gated additionally by the platform flag `APP_QUESTIONNAIRES_TONE_ENABLED`. See
[`interviewer-tone.md`](./interviewer-tone.md).

`respondentReport` (report kind `respondent`) is the per-respondent report delivered after a
respondent completes the questionnaire — a single JSON object (`RespondentReportSettings`):
`enabled`, `mode` (`raw | raw_plus_insights`), `rawIncludes` (data-slot values / questions as
presented), a `generation` block (free-text instructions + structure, a flat `backgroundContext`
blob, and `useClientKnowledge`), and `delivery` toggles (on-screen / download). Disabled by default,
so the default block changes nothing; gated additionally by the platform flag
`APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED`. Narrowed on read by `narrowRespondentReportSettings`
(`lib/app/questionnaire/report/settings.ts`). The mode-2 (`raw_plus_insights`) report is generated
once, asynchronously, after submit and stored in `AppRespondentReport`; raw mode renders on demand.
The `cohort` report kind (cross-respondent analysis) is a separate, later feature.

### Profile fields (JSON, not a relational model)

`profileFields` is an ordered `ProfileFieldConfig[]` — `{ key, label, type,
required, options? }`. A small, admin-authored, version-scoped list edited as one
unit and read wholesale at session start (P4), never queried field-by-field, so it
needs no separate model (the same shape precedent as `audience` / `typeConfig`).
`key` is a unique lowercase slug; `options` is required (non-empty, distinct) for
`select` and forbidden for every other type.

The values a respondent supplies for these fields are collected at session start and
persisted to `AppRespondentProfileSnapshot` — **only on the non-anonymous surface**. When
`anonymousMode = true` no profile is collected, stored, or surfaced. See
[`anonymous-mode.md`](./anonymous-mode.md) for the full PII contract (F8.3).

## Lazy materialization

No config row exists until the admin first saves — this keeps the F1.1 ingest path
and the no-config fork path untouched. Three consequences:

- **Read** — `getVersionGraph` (`_lib/detail.ts`) resolves an absent row to
  `DEFAULT_QUESTIONNAIRE_CONFIG` (which mirrors the column defaults) and reports
  `saved: false` on the returned `ConfigView`. The UI always renders a complete
  config; `saved` is what the launch gate keys on.
- **Write** — the first PATCH `upsert`s the row; later PATCHes update it.
- **Fork** — the fork writer copies the config row into the new draft **only when
  one exists** (a no-config source forks to a no-config draft — both read as
  defaults).

## The endpoint

`PATCH /api/v1/app/questionnaires/:id/versions/:vid/config` — admin-only, JSON, a
**partial** config (any subset of fields; an omitted key leaves the stored — or
default — value). There is no separate `GET`: the config rides the version graph
(`…/versions/:vid`) the detail page already fetches.

### Pipeline (order is load-bearing)

1. **Flag gate** — `404` when `APP_QUESTIONNAIRES_ENABLED` is off (runs first).
2. **`withAdminAuth`** — `401` / `403`.
3. **Scope-404** — `loadScopedVersion(id, vid)`; `404` on a cross-questionnaire mismatch.
4. **Validate** — `updateConfigSchema` (`400` on a bad body — see _Validation_).
5. **Fork-if-launched** — `forkVersionIfLaunched`; editing a `launched` version
   forks a fresh draft (its existing config copied in) and all writes target the
   draft. The fork outcome rides the response `meta` (`forked`, `versionId`,
   `versionNumber`) so the editor can notice and redirect.
6. **Upsert** — create-with-provided-fields (DB defaults fill the rest) or update.
7. **Audit** — `questionnaire_config.update` (`entityType: questionnaire_config`),
   with a before/after `computeChanges` diff.
8. **`200`** with the resolved `ConfigView` (`saved: true`) + the fork `meta`.

### Validation (`updateConfigSchema`)

Pure Zod in `lib/app/questionnaire/authoring/config-schema.ts`. All fields
optional, at least one required. Two cross-field rules via `superRefine` (the same
discipline as `type-config-schema.ts`):

- **Contradiction mode / N** — `contradictionWindowN` must be ≥ 1 when the mode is
  not `off`, and `0` when it is `off`.
- **Profile fields** — keys unique across the list; `select` requires a non-empty
  distinct `options` list; non-`select` types forbid `options`.

## The launch gate

`assertLaunchable` in the status route (`…/versions/:vid/status`) guards
`draft → launched`. F3.1 extends F2.1's minimal gate to require **all** of:

- a **goal**,
- a non-empty **audience** (an empty `{}` — which the editor may persist — counts
  as not populated, via a `hasAudience` helper),
- at least one **section**,
- at least one **question**,
- a **saved config row**.

Why "a row exists" rather than "config has values": every setting has a default, so
config is never literally empty. Requiring the row makes the admin **deliberately
open and save** the configuration before launch — saving all-defaults counts, it is
an opt-in. A version missing any condition gets a `400` whose `error.details` names
each unmet field (`goal` / `audience` / `sections` / `questions` / `config`), which
the editor renders inline.

## UI

`components/admin/questionnaires/config-editor.tsx` — a **Configuration** section
inside the existing `VersionEditor` (edit mode), hydrated from the
`VersionGraphView` the detail page already fetched (no second fetch). Plain
controlled state + the shared `run` mutation runner (the same pattern as the
goal/audience and section/question editors — **not** react-hook-form), a
`<FieldHelp>` ⓘ on every non-obvious field, `Switch` / `Select` primitives, and a
dynamic add/remove profile-fields list with a conditional comma-separated options
input for `select` fields. Saving a config on a launched version forks a draft and
redirects, handled by the shared `run` exactly as the other editor sections do.

The panel is a single long scroll of ~10 labelled `SettingsGroup` cards (Questions
& completion · Respondent experience · Intro screen · Reasoning stream · Preview
tools · Interviewer tone · Access & invitations · Answer quality & safeguarding ·
Budget & limits · Session-start profile fields). On wide screens a **sticky
scroll-spy rail** (`components/admin/section-rail.tsx`) sits beside it for
wayfinding — nothing moves, the single scroll and Cmd-F still work. The rail
**discovers its items from the DOM**: each `SettingsGroup` renders a Card with
`id` + `data-section-rail` + `data-section-label`, and the rail lists every such
card inside `#settings-sections`, so flag-gated sections (e.g. Intro screen) appear
in the rail exactly when they render, with no duplicated visibility logic. The rail
is generic and reusable for any long settings panel.

### Import / export all settings

`components/admin/questionnaires/config-import-export.tsx` — an **Import / export
settings** toolbar pinned to the top of the panel. **Export** serialises the
resolved `ConfigView` into a portable JSON envelope (`{ kind, schemaVersion,
exportedAt, config }`) and downloads it client-side — no new endpoint. **Import**
reads such a file and PATCHes the whole parsed config back through the **same**
config endpoint the Save button uses, so fork-on-launch, the error banner, and the
refetch/resync all behave identically to a normal save; a confirm dialog previews
the settings count first because importing overwrites every field (including unsaved
edits).

The envelope helpers live in `lib/app/questionnaire/authoring/config-export.ts`
(pure — no Prisma/Next/DOM): `buildSettingsExport` / `extractConfig` (drops the
read-only `saved` flag) and `parseSettingsImport` (validates the JSON + `kind`
discriminator, strips unknown/metadata keys, requires ≥1 recognised setting). The
key list is derived from `DEFAULT_QUESTIONNAIRE_CONFIG`, so a new config field is
exported the moment it gains a default — it can never drift. Value-level validation
stays server-side in `updateConfigSchema`; the client only shapes + sanity-checks
the file. `respondentReport` / `cohortReport` (edited on their own surfaces) are
carried too, so the export is a complete round-trip of the version's config.

## Who consumes it

F3.1 stores the settings; later phases read them. `costBudgetUsd` is **stored
only** — pre-launch **cost estimation** ([F3.3](cost-estimation.md)) reads it to
flag an over-budget projection, and turn-boundary cap enforcement is F6.3.
Selection strategy + thresholds feed F4.1 (the four pluggable strategies —
sequential, random, weighted, adaptive — see [selection strategies](selection-strategies.md));
the per-turn replies those questions draw are turned into typed slot values by
F4.2 ([answer extraction](answer-extraction.md)); contradiction mode/N feeds F4.3;
the completion thresholds (`minQuestionsAnswered`, `coverageThreshold`) and
`maxQuestionsPerSession` feed F4.5's offer-to-submit gate
([completion logic](completion-logic.md)); voice feeds F6.2; profile-field
collection at session start lands in P4.

## Not in F3.1

Cost _estimation_ (F3.3) and any consumer of the stored settings (F4 selection,
F4.3 contradiction, F6 turn engine, P4 session start). A separate relational
profile-field model (JSON by decision). Invitations (F3.2) and demo-client
invitation branding (F3.4).
