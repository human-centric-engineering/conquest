# Questionnaire — configuration

> The per-version run-time configuration an admin authors before launch, and the
> launch gate that decides when a version may go live. Built by **F3.1**
> ([`../planning/features/f3.1.md`](../planning/features/f3.1.md)) — the first
> feature of P3. Always on. Builds on the
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

| Setting                               | Column                      | Type                   | Default             |
| ------------------------------------- | --------------------------- | ---------------------- | ------------------- |
| Question selection strategy           | `selectionStrategy`         | String (enum)          | `'adaptive'`        |
| Completion: min questions             | `minQuestionsAnswered`      | Int                    | `0`                 |
| Completion: coverage threshold        | `coverageThreshold`         | Float (0–1)            | `1.0`               |
| Early finish: allow                   | `allowEarlyFinish`          | Boolean                | `false`             |
| Early finish: min coverage            | `earlyFinishMinCoverage`    | Float (0–1; 0 = off)   | `1.0`               |
| Early finish: min questions           | `earlyFinishMinQuestions`   | Int (0 = off)          | `0`                 |
| Cost budget (USD / session)           | `costBudgetUsd`             | Float? (null = no cap) | `null`              |
| Per-session question cap              | `maxQuestionsPerSession`    | Int? (null = no cap)   | `null`              |
| Voice input                           | `voiceEnabled`              | Boolean                | `false`             |
| Contradiction-detection mode          | `contradictionMode`         | String (enum)          | `'off'`             |
| Contradiction look-back window N      | `contradictionWindowN`      | Int                    | `0`                 |
| Contradiction cadence (every N turns) | `contradictionEveryNTurns`  | Int                    | `1`                 |
| Answer-fit resolver mode              | `answerFitMode`             | String (enum)          | `'fallback'`        |
| Anonymous mode (identity axis)        | `anonymousMode`             | Boolean                | `false`             |
| Access mode (who may start)           | `accessMode`                | String (enum)          | `'invitation_only'` |
| Invitee detail fields                 | `inviteeFields`             | Json (array)           | email + names       |
| Abuse threshold (seriousness gate)    | `abuseThreshold`            | Int (0 = off)          | `4`                 |
| Sensitivity awareness (safeguarding)  | `sensitivityAwareness`      | Boolean                | `false`             |
| Support message (signpost copy)       | `supportMessage`            | String (empty = off)   | `''`                |
| Support resource URL                  | `supportResourceUrl`        | String (URL)           | `''`                |
| Session-start profile fields          | `profileFields`             | Json (array)           | `[]`                |
| Answer panel scope                    | `answerSlotPanelScope`      | String (enum)          | `'full_progress'`   |
| Presentation mode                     | `presentationMode`          | String (enum)          | `'both'`            |
| Respondent layout                     | `respondentLayout`          | String (enum)          | `'classic'`         |
| Opening chat text size                | `chatTextSize`              | String (enum)          | `'standard'`        |
| Inline answer correction              | `inlineCorrectionEnabled`   | Boolean                | `true`              |
| Session resume                        | `sessionResumeEnabled`      | Boolean                | `true`              |
| Show percent-completed text           | `showProgressPercentText`   | Boolean                | `true`              |
| Completeness milestone banners        | `milestoneBannerEnabled`    | Boolean                | `true`              |
| Milestone thresholds (percent)        | `milestoneBannerThresholds` | Json (number array)    | `[25,50,75,90]`     |
| Interviewer tone & persona            | `tone`                      | Json (object)          | all dimensions off  |
| Respondent Report                     | `respondentReport`          | Json (object)          | disabled, raw mode  |

The enums are `const` tuples in `lib/app/questionnaire/types.ts` (single source of
truth — the Zod schema, the read-view narrowing, and the editor's `<Select>`
options all derive from them): `SELECTION_STRATEGIES`
(`sequential | weighted | adaptive`), `CONTRADICTION_MODES` (`off | flag | probe`),
`PROFILE_FIELD_TYPES` (`text | email | number | select`), `ANSWER_SLOT_PANEL_SCOPES`
(`full_progress | answered_only | hidden`), `PRESENTATION_MODES` (`chat | form | both`).

`answerSlotPanelScope` (F7.2) is read by the respondent answer-panel endpoint
(`GET …/questionnaire-sessions/:id/answers`), not the turn engine: `full_progress`
returns every slot grouped by section (an X-of-N progress view), `answered_only`
returns just the captured answers so the pending structure is never sent to the
client, and `hidden` is the **chat-only** surface — the respondent sees no panel at
all (no side panel on `lg`+, no mobile "Review answers" sheet, no data slots on show).
`hidden` is a presentation choice, not a privacy one: the endpoint filters it exactly
like `answered_only`, because the captured answers still feed inline correction and the
completion screen's cycler. It is orthogonal to `presentationMode` — a hidden panel
still allows a form tab. See `.context/app/questionnaire/answer-slot-panel.md`.

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

`respondentLayout` (F-layouts) chooses how the respondent surface is ARRANGED — where the
conversation, the captured answers and the controls sit. Orthogonal to `presentationMode`
below, which decides what the respondent completes rather than where it sits; every
combination is valid. `classic` (the default) is the conversation with the answer panel
beside it; `focus` is one column at every width with the answers a tap away in a sheet;
`broadsheet` reads the conversation as a document with the answer box held still in the
margin; `horizon` shows one question at a time with the conversation so far folded into a
disclosure above it.
Whichever is chosen, every feature stays reachable — the layout registry enforces that at
compile time. Both the read path and the component resolver fall back to `classic` for an
absent or unrecognised value, so no existing questionnaire changes appearance and a rollback
cannot blank a live surface. See `.context/app/questionnaire/respondent-layouts.md`.

`chatTextSize` (`small` | `standard` | `large` | `largest`) chooses where the respondent's
text-size ladder OPENS — the rung a respondent who has never touched the in-session stepper
starts on. Deliberately a starting point and not a cap: it is handed to the respondent's
stored preference as its `initial`, so anyone who has ever used the stepper keeps their own
size and this value is never consulted for them. There is no switch that removes the
stepper, and no authored value that can pin it — an accessibility affordance an author
could override would not be one. Absent or unrecognised resolves to `standard`, the size
every questionnaire had before the setting existed. See
`.context/app/questionnaire/chat-text-size.md`.

`respondentChrome` (F-chrome) chooses how much of ConQuest shows AROUND the respondent
surface: `full` (the default — the site header and footer every respondent page has always
had), `co_branded` (a slim ConQuest line above the client's own brand band, nothing below),
or `white_label` (the questionnaire alone, including the browser tab). Orthogonal to
`respondentLayout`, which arranges the questionnaire's own parts inside whatever chrome this
leaves. It applies to the three standalone respondent pages (`/q`, `/x`, `/m`), which now
live in the `app/(respondent)` route group so they inherit no chrome by default; the
signed-in `/questionnaires/[sessionId]` surface keeps the app's own navigation whatever this
says, since a respondent with an account is inside the product and hiding it would strand
them. Both the read path and the component resolve an absent or unrecognised value to
`full`, so no existing questionnaire changes appearance and a rollback cannot strip a live
page of its chrome. See `.context/app/questionnaire/respondent-chrome.md`.

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
questions shows no gesture. On by default — the admin toggles it per version on the Settings tab.
The respondent
pages resolve it (`resolveInlineCorrectionForVersion` / `loadSessionSurfaceConfig`) and pass it to
`SessionWorkspace`; the read-only admin session viewer never shows it. See
`.context/app/questionnaire/answer-slot-panel.md`.

`tone` (F-tone) is the interviewer's voice — a single JSON object (`ToneSettings`) of nine
enable-toggle + 1–5 sliders (empathy, mirroring, formality, mimicry, verbosity, warmth, curiosity,
reading complexity, humour) plus a free-text `persona`. Each dimension is off by default, so the
default block changes nothing. The live phraser renders the **enabled** dimensions into its system
prompt; governed by this per-version `tone` config alone. See
[`interviewer-tone.md`](./interviewer-tone.md).

`houseRules` is the interviewer's **behaviour policy** for this questionnaire — a single JSON object
(`HouseRulesSettings`): an `enabled` master switch plus an ordered list of typed rules, each
`always` (a standing instruction), `never` (a prohibition), or `if_asked` (a `trigger` the respondent
raises paired with the answer to give). Distinct from `tone` (how the interviewer sounds) and
`interviewerStrategy` (how it questions): house rules govern what it may and may not **do** — "never
give advice", "always ask for a concrete example", "if they ask who sees their answers, say X". Off
by default with no rules, so the default block changes nothing. Capped at 20 rules × 400 characters
because every enabled rule ships in **every turn's** system prompt. Narrowed on read by
`narrowHouseRules` and rendered by `buildHouseRulesInstructions`
(`lib/app/questionnaire/chat/house-rules.ts`) into a `<house_rules>` section that sits after
`<tone>` (so client policy beats the voice dials) and before `<output_format>` (so a rule can never
break the reply contract). Applies to both the question phraser and the wrap-up message. See
[`interviewer-house-rules.md`](./interviewer-house-rules.md).

`respondentReport` (report kind `respondent`) is the per-respondent report delivered after a
respondent completes the questionnaire — a single JSON object (`RespondentReportSettings`):
`enabled`, `mode` (`raw | raw_plus_insights`), `rawIncludes` (data-slot values / questions as
presented), a `generation` block (free-text instructions + structure, a flat `backgroundContext`
blob, and `useClientKnowledge`), and `delivery` toggles (on-screen / download). Disabled by default,
so the default block changes nothing; governed by this per-version `respondentReport` config
alone (`enabled`). Narrowed on read by `narrowRespondentReportSettings`
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

1. **`withAdminAuth`** — `401` / `403`.
2. **Scope-404** — `loadScopedVersion(id, vid)`; `404` on a cross-questionnaire mismatch.
3. **Validate** — `updateConfigSchema` (`400` on a bad body — see _Validation_).
4. **Fork-if-launched** — `forkVersionIfLaunched`; editing a `launched` version
   forks a fresh draft (its existing config copied in) and all writes target the
   draft. The fork outcome rides the response `meta` (`forked`, `versionId`,
   `versionNumber`) so the editor can notice and redirect.
5. **Upsert** — create-with-provided-fields (DB defaults fill the rest) or update.
6. **Audit** — `questionnaire_config.update` (`entityType: questionnaire_config`),
   with a before/after `computeChanges` diff.
7. **`200`** with the resolved `ConfigView` (`saved: true`) + the fork `meta`.

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

**Fork confirmation (all authoring surfaces).** Forking a launched version is a
silent version increment that surprised admins — the change lands on a _new draft_,
not the live version, so in-progress sessions (pinned to the launched version) never
see it. The confirmation is enforced at the **server choke point** so it covers every
edit that can fork (Structure, Settings, respondent report, reingest, data slots,
tag/extraction edits, advisor-applied config — and any future one), not one surface:

- **Server** — `forkVersionIfLaunched` (`_lib/fork.ts`) reads the request's
  `x-fork-confirm` header. `confirmed` → fork; `prompt` (an interactive client that
  hasn't confirmed) → throw `ForkConfirmationRequiredError` (409, code
  `VERSION_FORK_CONFIRMATION_REQUIRED`) **before any write**, carrying
  `{ sourceVersionNumber, nextVersionNumber, versions }`; header absent (`legacy`:
  programmatic API clients, seeds/scripts, non-request contexts) → fork silently, so
  existing callers and integration tests are unaffected.
- **Client** — `authoringMutate` (the one helper every editor mutation uses) tags each
  request `x-fork-confirm: prompt`; on the 409 it calls `requestForkConfirm(details)`
  (the `fork-confirm-bridge` module) and either retries with `x-fork-confirm: confirmed`
  or throws `ForkCancelledError`. `ForkConfirmProvider` — mounted once in the version
  workspace layout — registers the handler and renders the single
  `LaunchedEditConfirmDialog` (names v*current* → v*next*, lists existing versions with
  statuses, notes live sessions stay on v*current* until v*next* launches). Runners
  treat `ForkCancelledError` as a silent no-op (resync from the server, no error
  banner). A **draft** edit never triggers the 409, so no dialog appears.

The panel is a single long scroll of ~10 labelled `SettingsGroup` cards (Questions
& completion · Respondent experience · Intro screen · Reasoning stream · Preview
tools · Interviewer tone · Access & invitations · Answer quality & safeguarding ·
Budget & limits · Session-start profile fields). On wide screens a **sticky
scroll-spy rail** (`components/admin/section-rail.tsx`) sits beside it for
wayfinding — nothing moves, the single scroll and Cmd-F still work. The rail
**discovers its items from the DOM**: each `SettingsGroup` renders a Card with
`id` + `data-section-rail` + `data-section-label`, and the rail lists every such
card inside `#settings-sections`, so conditionally-rendered sections (e.g. Intro screen)
appear in the rail exactly when they render, with no duplicated visibility logic. The rail
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
`maxQuestionsPerSession` feed F4.5's offer-to-submit gate, while the early-finish
fields (`allowEarlyFinish`, `earlyFinishMinCoverage`, `earlyFinishMinQuestions`) feed the
respondent's parallel escape hatch ([completion logic](completion-logic.md)); voice feeds
F6.2; profile-field collection at session start lands in P4.

## Not in F3.1

Cost _estimation_ (F3.3) and any consumer of the stored settings (F4 selection,
F4.3 contradiction, F6 turn engine, P4 session start). A separate relational
profile-field model (JSON by decision). Invitations (F3.2) and demo-client
invitation branding (F3.4).

## Definitions / glossary (P16)

Three switches govern how the version's curated terms are used. All three are **inert** when the
version has no accepted terms, which is why the first two default on: an admin who never opens the
Definitions tab sees no change at all.

| Key                       | Default     | Effect                                                                                                                                                                 |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glossaryPromptInjection` | `true`      | Folds the terms relevant to the current turn into the interviewer, extraction, refinement and contradiction prompts, and the whole accepted set into report generation |
| `glossaryRespondentHints` | `true`      | Underlines a matched term in the interviewer's messages and on form labels, with the definition in a popover                                                           |
| `glossaryReportAppendix`  | **`false`** | Appends the glossary to the respondent's report and PDF. Off by default because it changes a delivered document                                                        |

The blank **instrument** export always carries the glossary regardless of `glossaryReportAppendix`
— that switch governs what the _respondent_ receives, and the instrument is the reviewer's copy.

See [`definitions-glossary.md`](./definitions-glossary.md).

## Progress display & completeness milestones (F-progress)

Two independent, respondent-facing toggles, both on by default — Settings → **Respondent
experience** (the percent text) and its own **Progress milestones** group (the banners):

- `showProgressPercentText` — the "N% completed" label beside the session progress bar
  (`SessionProgressBar`, threaded through `SessionLifecycleBar` → `SessionWorkspace` → each
  respondent page). The bar itself always renders; this only toggles the numeric label.
- `milestoneBannerEnabled` + `milestoneBannerThresholds` (`number[]`, 1–99 each, default
  `[25, 50, 75, 90]`, admin add/remove up to `MAX_MILESTONE_THRESHOLDS` (12), unique, sorted
  ascending on read) — when the respondent's graded `displayCoverage` (the same figure the
  progress bar shows) crosses a configured threshold, a `warning` event with `code: 'milestone'`
  is emitted and a quiet "You're N% of the way through." banner renders inline in the chat via
  `TurnNotices` → `MilestoneNotice` (mirrors the `support`/`seriousness`/`contradiction` pattern).

  **N is the respondent's actual coverage, not the threshold that fired** (`MilestoneOutcome.coveragePct`,
  not `.announce`). The threshold decides _whether_ to speak; coverage decides what is _true_. The
  two come apart whenever thresholds are sparse or one rich answer clears several at once — a lone
  threshold of `40` with the respondent at 92% would otherwise read "You're 40% of the way through."
  beside a progress bar showing 92%, and the default list, topping out at 90, would tell a fully
  completed session it was 90% done.

  The decision itself is the pure `resolveMilestoneCrossing`
  (`lib/app/questionnaire/completion/milestones.ts`), called from **both** turn pipelines —
  `runTurn` _and_ `runDataSlotTurn`. That sharing is load-bearing, not tidiness: any version with
  data slots takes the data-slot pipeline, so logic living only in `runTurn` makes the feature a
  silent no-op for most real questionnaires.

  **At most one banner per turn.** A turn can clear several thresholds at once (a rich answer
  filling three slots; or a short questionnaire where one answer is worth 50%), so only the
  _highest_ crossed threshold is announced — stacking three banners under one reply reads as a
  glitch. Every threshold jumped over is still banked in the ledger, so a skipped one can never
  fire later and announce progress the respondent passed long ago.

  Fires **once per threshold per session**: `AppQuestionnaireSession.raisedMilestones` (`Json`,
  `number[]`, default `[]`) is a ledger checked before firing — a threshold already in it never
  re-fires. A ledger rather than a diff against a previous coverage figure precisely because
  coverage is **not monotonic**: a contradiction resolution can invalidate an answer and pull the
  number back down, and nothing should re-announce on the way back up. Same shape and wiring as
  the contradiction "don't nag" ledger
  (`raisedContradictions`): loaded in `buildTurnContext`, written back via `persistTurn` →
  `prisma.appQuestionnaireSession.update` alongside `pendingContradiction`/`raisedContradictions`
  in one call, and the milestone `warning` persists on `AppQuestionnaireTurn.warnings` for replay
  on resume (no separate plumbing needed there — any `{type:'warning', code, message}` event
  already rides that pipe).
