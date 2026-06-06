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

| Setting                          | Column                   | Type                   | Default           |
| -------------------------------- | ------------------------ | ---------------------- | ----------------- |
| Question selection strategy      | `selectionStrategy`      | String (enum)          | `'sequential'`    |
| Completion: min questions        | `minQuestionsAnswered`   | Int                    | `0`               |
| Completion: coverage threshold   | `coverageThreshold`      | Float (0–1)            | `1.0`             |
| Cost budget (USD / session)      | `costBudgetUsd`          | Float? (null = no cap) | `null`            |
| Per-session question cap         | `maxQuestionsPerSession` | Int? (null = no cap)   | `null`            |
| Voice input                      | `voiceEnabled`           | Boolean                | `false`           |
| Contradiction-detection mode     | `contradictionMode`      | String (enum)          | `'off'`           |
| Contradiction look-back window N | `contradictionWindowN`   | Int                    | `0`               |
| Anonymous mode                   | `anonymousMode`          | Boolean                | `false`           |
| Session-start profile fields     | `profileFields`          | Json (array)           | `[]`              |
| Answer panel scope               | `answerSlotPanelScope`   | String (enum)          | `'full_progress'` |

The enums are `const` tuples in `lib/app/questionnaire/types.ts` (single source of
truth — the Zod schema, the read-view narrowing, and the editor's `<Select>`
options all derive from them): `SELECTION_STRATEGIES`
(`sequential | weighted | adaptive`), `CONTRADICTION_MODES` (`off | flag | probe`),
`PROFILE_FIELD_TYPES` (`text | email | number | select`), `ANSWER_SLOT_PANEL_SCOPES`
(`full_progress | answered_only`).

`answerSlotPanelScope` (F7.2) is read by the respondent answer-panel endpoint
(`GET …/questionnaire-sessions/:id/answers`), not the turn engine: `full_progress`
returns every slot grouped by section (an X-of-N progress view), `answered_only`
returns just the captured answers so the pending structure is never sent to the
client. See `.context/app/questionnaire/answer-slot-panel.md`.

### Profile fields (JSON, not a relational model)

`profileFields` is an ordered `ProfileFieldConfig[]` — `{ key, label, type,
required, options? }`. A small, admin-authored, version-scoped list edited as one
unit and read wholesale at session start (P4), never queried field-by-field, so it
needs no separate model (the same shape precedent as `audience` / `typeConfig`).
`key` is a unique lowercase slug; `options` is required (non-empty, distinct) for
`select` and forbidden for every other type.

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
