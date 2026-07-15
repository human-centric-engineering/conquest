# Respondent profile capture (F-capture)

How a questionnaire collects a respondent's **profile fields** (name, email, organisation…) — the
admin-authored `profileFields` on the version config — and how each field's value is validated. This
supersedes the F8.3 pre-session `ProfileStartForm`: capture now rides the respondent carousel as a
**blocking form gate** (the default), with an alternative **conversational** mode, and per-field
validation that can be deterministic, agentic, or hybrid.

Related: [`anonymous-mode.md`](./anonymous-mode.md) (the PII contract this gates under), the answer
extraction pipeline (`answer-extraction.md`), and the carousel workspace (F7.2 answer-slot panel).

## The two ways to collect (`captureMode`)

`AppQuestionnaireConfig.captureMode` (`CAPTURE_MODES = 'form' | 'conversational'`, default `form`)
decides HOW the fields are gathered:

- **`form`** (default) — a standard form rides the workspace carousel **after the intro and before the
  chat/interviewer**. It is a **blocking gate**: the respondent cannot advance (and no opening LLM turn
  streams) until they submit valid details. Component:
  `components/app/questionnaire/profile/profile-capture-gate.tsx`.
- **`conversational`** — no gate. The interviewer's system prompt carries a directive
  (`buildProfileCaptureInstructions`) telling it to gather the fields naturally in-chat, and a
  best-effort post-turn pass (`extractAndPersistConversationalProfile`) maps the transcript to the
  fields and persists them once complete. Both live in
  `lib/app/questionnaire/profile/conversational-capture.ts`.

## The identity axis — the gate keys off `anonymousMode`, not login

**The decisive rule.** Capture is offered whenever the version is **not** `anonymousMode` — regardless
of whether the respondent is authenticated or on a public no-login link. So:

- A **public no-login** link CAN collect a name (when the admin wants one) — `anonymousMode` off.
- A truly **anonymous** link (`anonymousMode` on) stays PII-free: no gate, no directive, no snapshot,
  ever. This preserves "a public link without naming the respondent."

The `anonymousMode` invariant is enforced in **three** places (defence in depth): the resolver returns
`null`, the runtime PUT rejects, and the workspace's `showCapture` is false. The server PUT is the true
boundary. `resolveSessionCapture` (`lib/app/questionnaire/profile/resolve-capture.ts`) — NOT the old
`start-context.ts` — owns this decision.

## Per-field validation (`validation`)

Each `ProfileFieldConfig` carries a `validation` mode (`PROFILE_FIELD_VALIDATION_MODES =
'deterministic' | 'agentic' | 'hybrid'`, default `deterministic`; legacy stored fields without the key
read as `deterministic`). Enforced server-side by `validateProfileSubmission`
(`lib/app/questionnaire/profile/validate-profile-fields.ts`):

- **`deterministic`** — Zod/regex only (format, required, select membership). No LLM. Reuses
  `buildProfileValuesSchema` from `profile-values.ts` so the client form and server share the rules.
- **`agentic`** — structural checks (required, number/select) stay deterministic; `text`/`email`
  plausibility + normalisation are delegated to a batched LLM pass that BOTH tidies the value
  (proper-case names, neat organisation, E.164-ish phone) AND flags garbage (`asdf`, `test@test`).
- **`hybrid`** — the deterministic gate runs first (a format failure rejects **without** spending an
  LLM call); on pass, the agentic layer normalises/flags.

**The agentic layer is non-fatal.** An LLM outage / timeout / malformed response falls back to the
deterministic-passed value and never blocks a respondent (mirrors `resolveAnswerFit`'s convention in
`capabilities/extract-answer-slots.ts`). All agentic/hybrid non-`select` fields batch into **one**
`runStructuredCompletion` call (cheap `chat`-tier model), cost logged via `logCost`
(`capability: 'profile_validation'`).

## Runtime flow (form mode)

1. **Session is created first** (unlike the superseded pre-session form). The authed `/start` page just
   creates/resumes and redirects; capture happens in-carousel.
2. **Resolve** — the authed page SSR-calls `resolveSessionCapture(sessionId)`; the no-login boot
   (`anonymous-session-boot.tsx`) fetches `GET …/:id/profile` (`fetchCapture`, fails soft to `null`).
3. **Gate** — `SessionWorkspace` inserts a `capture` carousel surface (intro → **capture** → persona →
   chat) when `captureMode === 'form'`, fields exist, `!satisfied`, and not read-only. It defers the
   LLM kickoff until submit and suppresses the surface toggle / forward-nav while the gate blocks.
4. **Submit** — `PUT …/:id/profile { profileValues }`. The route re-derives the fields from stored
   config (never trusts the client), **re-runs validation authoritatively** (incl. the agentic pass),
   then upserts `AppRespondentProfileSnapshot`. A `400 INVALID_PROFILE` carries `fieldErrors`, mapped
   back onto the inputs. On success the gate calls `onSubmitted`, releasing the kickoff.

`satisfied` = a snapshot already exists (resume) OR the mode is conversational OR there are no fields —
so the gate is skipped on resume.

## Persistence

One `AppRespondentProfileSnapshot` per session (1:1 on `sessionId`). All writers — session-create
(legacy), the in-flow PUT, and conversational extraction — go through the shared idempotent
`upsertProfileSnapshot` (`lib/app/questionnaire/profile/profile-snapshot.ts`) so they never race on the
unique constraint. `respondentUserId` is the authed owner (for the GDPR cascade) or `null` for a
non-anonymous no-login respondent. The row is unchanged from F8.3 (PII, `onDelete: Cascade` on both
FKs — see [`../../privacy/data-erasure.md`](../../privacy/data-erasure.md)).

## Key files

| Concern                 | Path                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Validation service      | `lib/app/questionnaire/profile/validate-profile-fields.ts`                               |
| Capture resolver (DB)   | `lib/app/questionnaire/profile/resolve-capture.ts`                                       |
| Shared snapshot upsert  | `lib/app/questionnaire/profile/profile-snapshot.ts`                                      |
| Client form schema      | `lib/app/questionnaire/profile/form-schema.ts`                                           |
| Conversational mode     | `lib/app/questionnaire/profile/conversational-capture.ts`                                |
| Runtime endpoint        | `app/api/v1/app/questionnaire-sessions/[id]/profile/route.ts`                            |
| Carousel gate + surface | `components/app/questionnaire/session-workspace.tsx`, `profile/profile-capture-gate.tsx` |
| Admin config UI         | `components/admin/questionnaires/config-editor.tsx` (Respondent profile fields group)    |
| Config schema / types   | `lib/app/questionnaire/authoring/config-schema.ts`, `lib/app/questionnaire/types.ts`     |

## No platform flag

Capture is gated purely by per-version config (like `profileFields` itself), not a platform feature
flag — there is no `APP_QUESTIONNAIRES_CAPTURE_*` row. See [[feature-flags-are-db-rows]] for how the
platform flags that DO gate the surrounding surfaces (live sessions, etc.) work.
