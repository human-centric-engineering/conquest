# Per-invitation diagnostics (Diagnostics)

A persisted **error trail** plus a per-invitation **telemetry** rollup, surfaced on a new admin
**Diagnostics** tab. It answers "what happened — and what went wrong — for this invitee?".

The live respondent surface is deliberately **fail-soft**: a turn that throws is logged via
`logger.error(...)` and either returns a 500 or continues, and a bookkeeping write that fails is
swallowed. That keeps a respondent moving, but it meant failures left **no queryable trail**. This
feature adds one: an always-on capture seam writes an `AppQuestionnaireError` row, and a read surface
rolls the errors up alongside the per-turn telemetry already captured on each turn.

## What's captured

### Telemetry — denormalized onto `AppQuestionnaireTurn`

The per-turn LLM/embedding calls were already persisted on every turn in `inspectorCalls`
(`AgentCallTrace[]`: model, latency, cost, `tokensIn`/`tokensOut`, raw prompt/response). Three
columns denormalize the rollup basis so the Diagnostics table aggregates without parsing that JSON:

| Column             | Source                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `durationMs`       | end-to-end turn wall-clock (route entry → persist) — **not** derivable from per-call latency |
| `promptTokens`     | `Σ inspectorCalls.tokensIn` (`totalInspectorTokensIn`)                                       |
| `completionTokens` | `Σ inspectorCalls.tokensOut` (`totalInspectorTokensOut`)                                     |

`inspectorCalls` stays the per-call source of truth (and the deep-dive material). The messages route
computes the three values just before `persistTurn`, which threads them → `recordTurn` → the row.

### Errors — `AppQuestionnaireError`

One row per failure (or notable refusal), written best-effort by
`recordQuestionnaireError()` (`lib/app/questionnaire/diagnostics/record-error.ts`). Two hard rules:

1. **Never throws.** It runs on already-failing paths; all work is wrapped, so a capture failure can't
   make things worse (it logs and returns).
2. **Low-PII by construction.** It stores `code`/`stage`/`message`/`stack` + a redacted `metadata`
   only — never the raw respondent `userMessage`. The deep-dive raw prompt/response comes from the
   turn's persisted `inspectorCalls`, not from here.

`versionId` is a real FK with `onDelete: Cascade` (rows are swept when the version is deleted);
`sessionId`/`invitationId` are plain identity pointers (no FK), matching the schema's UG-1 house
style. When only a `sessionId` is known (e.g. a top-level catch), the helper backfills
`versionId`/`invitationId` from the session.

#### Capture points (scope · severity)

| Where                                                  | scope             | severity      |
| ------------------------------------------------------ | ----------------- | ------------- |
| Turn orchestrator throws (`runTurn`/`runDataSlotTurn`) | `pipeline`        | error         |
| `persistTurn` fails (reply already streamed)           | `persist`         | error         |
| Abuse / sensitivity bookkeeping write fails            | `turn`            | error         |
| Unexpected 5xx in the messages route (top-level catch) | `turn`            | error         |
| Hard cost-cap refusal (402, session paused)            | `cost_cap`        | warning       |
| Round-gate refusal (window closed / member removed)    | `round_gate`      | info          |
| Session create rejected / throws                       | `session_create`  | warning/error |
| Invitation email send failed                           | `invitation_send` | warning       |

A genuine fault is `error`; a clean refusal that still ran correctly is `warning`/`info` — the
surface filters on this. Expected client errors (validation 400, access 401/403) are **not**
recorded — only `status >= 500` reaches the top-level capture, and the cost-cap/round-gate refusals
record their own typed rows.

On a pipeline throw the messages route also emits a graceful `error` SSE frame + a terminal `done`,
so the respondent surface unlocks for a retry instead of hanging on a dead stream.

## The read surface

`lib/app/questionnaire/analytics/diagnostics.ts` (sibling to `cost.ts`):

- `getVersionDiagnostics(scope)` — aggregate totals (sessions, turns, tokens, cost, avg + **p95**
  turn wall-clock via raw `percentile_cont`, error tallies by severity) + one row per invitation.
  Sessions with no invitation (walk-up/public) and unattributed errors fold into a synthetic
  **"(no invitation)"** row. Invitations with no session still appear (invited-but-never-started).
- `getInvitationDiagnostics(versionId, invitationId)` — drill-down: lifecycle, every session's
  per-turn telemetry timeline, the full `inspectorCalls` deep-dive, and the captured error log.
  Returns `null` (→ 404) when the invitation isn't on the given version.
- `getStageLatency(sessionIds, from, to)` — **where a turn's wall-clock goes**, split by pipeline
  stage. See the section below; also returned inline on `getVersionDiagnostics` as `stageLatency`.

### Where the time goes (stage latency)

A respondent waits through four to six sequential model calls before the first token of the reply
appears, and there was no way to tell which of them the wait actually was. `getStageLatency` answers
that from telemetry **already on disk** — no schema change, no migration, nothing new captured.

Two raw queries unnest each turn's `inspectorCalls` jsonb array:

| Figure                 | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `stages[].calls`       | how many calls carried this `AgentCallTrace.label` in the window                          |
| `stages[].avgMs/p95Ms` | latency of a **single call** of that stage                                                |
| `stages[].perTurnMs`   | what the stage adds to an **average turn** (`totalMs / turns`) — the number to compare on |
| `residualMs`           | turn wall-clock **not** spent in any model call: database, embedding, persistence         |

Grouping is by the call's own recorded label, not a hard-coded enum, so a stage added later shows up
without this module changing.

Three things to know before reading the numbers:

1. **Both queries are restricted to turns with a `durationMs`.** That is what makes the stage totals
   and the residual describe the same population, so `perTurnMs` is a true per-turn figure rather
   than a total over a different denominator. Pre-telemetry turns have neither a duration nor any
   calls and drop out of both.
2. **`perTurnMs` is not the average call.** A stage that runs on half the turns shows a per-turn
   figure half its own average — which is the point: it is what the stage costs the conversation,
   not what it costs when it runs.
3. **The residual is a floor, not a measurement, once stages overlap.** Today every model call in a
   turn runs strictly one after another, so summed call latency is bounded by the wall-clock and the
   difference is real overhead. Deliberately overlapping stage-1 calls (P20 Phase 3) lets the summed
   latency exceed the wall-clock, and `residualMs` clamps to 0. That reads honestly as "the turn was
   model-bound throughout", but it stops being an overhead measurement.

### Privacy posture

Diagnostics is an admin **debug** tool keyed on the invitation, so — unlike the aggregate cost
surface — it does **not** apply low-N (k-anonymity) suppression: an admin debugging a tiny pilot
still needs the per-invitee view, and already knows whom they invited. It **does** honour the
version's `anonymousMode` opt-in: when on, `identitySuppressed` is true and email/name are withheld
(the UI falls back to the invitation short-id), while the operational telemetry + errors still show.

## API

| Route                                                              | Returns                       |
| ------------------------------------------------------------------ | ----------------------------- |
| `GET …/questionnaires/:id/versions/:vid/diagnostics`               | `VersionDiagnosticsResult`    |
| `GET …/questionnaires/:id/versions/:vid/diagnostics/:invitationId` | `InvitationDiagnosticsResult` |

Admin-only (`withAdminAuth`), version-scoped via `loadScopedVersion`; query params `from`/`to`/`roundId` reuse the shared `questionnaireAnalyticsQuerySchema`.

## UI

- **Tab** — `diagnostics` in `QUESTIONNAIRE_WORKSPACE_TABS`, gated on the `liveSessions` flag
  (diagnostics is meaningless without respondent sessions; error **capture** is always-on regardless).
- **Version page** — `app/admin/questionnaires/[id]/v/[vid]/diagnostics/page.tsx` → `DiagnosticsView`
  (stat tiles, the **Where the time goes** stage-latency panel, and the per-invitation table, with a
  date-window GET filter). The panel is `StageLatencyPanel`; its last row — _Not in a model call_ —
  is the one to read first, because if it dominates then shaving model round-trips will not make the
  conversation feel faster.
- **Drill-down** — `…/diagnostics/[invitationId]/page.tsx` → `InvitationDiagnosticsView` (lifecycle,
  telemetry tiles, error log with stack/metadata expanders, per-turn table with a read-only inspector
  deep-dive via `DiagnosticsInspectorCalls`).

## Gates & flags

Error **capture** has no flag (a failure must never be missed). The **tab** and **read routes' UI**
are gated on `liveSessions`; the API routes are master-flag-gated like the other analytics routes.
No new feature-flag row was added.

## No CHANGELOG entry

App surface (`AppQuestionnaireError`, app routes/UI), not the Sunrise platform public surface.
