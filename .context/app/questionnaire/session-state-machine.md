# Session state machine (F4.6)

A respondent's run over a launched version is an `AppQuestionnaireSession` (F4.4). F4.6
gives it a lifecycle — `active | paused | completed | abandoned` — with a deterministic
transition machine, an append-only audit trail (one `AppQuestionnaireSessionEvent` per
transition), resume logic for paused sessions, and a cost-cap event hook wired for the
streaming engine to fire later.

Unlike F4.1–F4.5, **F4.6 is purely deterministic** — no LLM, so no capability, agent, or
sub-flag. It's gated by the master questionnaires flag only.

## Two layers: pure rules, seam writes

1. **The rules are pure.** `lib/app/questionnaire/session/` owns the legal-transition
   table and the classify/guard/event-mapping functions — data-in/data-out, no Prisma.
   Exhaustively unit-testable by hand (the P4 DoP), and the single authority on what's
   legal.
2. **The writes are the seam's.** `app/api/v1/app/questionnaires/_lib/sessions.ts` reads
   the current status, classifies the move, and — in one transaction — updates the status
   AND appends the event row. A status can never change without its audit row.

## The transition matrix

| from          | → paused | → active  | → completed | → abandoned |
| ------------- | :------: | :-------: | :---------: | :---------: |
| **active**    | ✅ pause |     —     | ✅ complete | ✅ abandon  |
| **paused**    |    —     | ✅ resume |     ❌      | ✅ abandon  |
| **completed** |    ❌    |   ❌\*    |      —      |     ❌      |
| **abandoned** |    ❌    |    ❌     |     ❌      |      —      |

\* Except the narrow, separately-gated respondent **reopen** action (early-finish only) —
see [Reopen (early-finish only)](#reopen-early-finish-only) below. It bypasses
`classifyTransition`/`LEGAL_TRANSITIONS` entirely via its own seam, so this matrix's ❌
remains true for every other caller (`resumeSession`, the admin `/transition` route).

- `paused → completed` is **illegal**: completion runs the F4.5 gate/sweep over a _live_
  session, so a paused session must `resume` first.
- `completed` / `abandoned` are **terminal** — for `classifyTransition` and the shared
  matrix, unconditionally and always.
- A **self-edge** (`from === to`, including terminal re-entry like `completed → completed`)
  is an idempotent **no-op** — no status change, **no event written**. This is what keeps
  the F4.5 accept→submit path idempotent.
- Any other edge throws `SessionTransitionError` — the route maps it to **409**.

`classifyTransition(from, to)` returns `'apply' | 'noop' | 'illegal'` — the single switch
the seam consumes. `canTransition`, `isTerminal`, `assertTransition`, and `eventTypeFor`
round out the core. **None of these were changed** to add the reopen exception — see below.

## Reopen (early-finish only)

The respondent early-finish "Continue answering" control (report screen, F-early-finish-
reopen) lets a `completed` session go back to `active` — but only when it completed via the
early-finish escape hatch, not a full natural completion. This is deliberately **not** an
edge in `LEGAL_TRANSITIONS`: adding `completed: ['active']` there would let every caller of
the shared matrix (`resumeSession`, the admin `/transition` route) reopen _any_ completed
session unconditionally, with no eligibility check.

Instead it's a separate, narrow path:

- **Pure eligibility** — `isReopenEligible` (`lib/app/questionnaire/session/reopen-logic.ts`):
  `status === 'completed' && allowEarlyFinish && !isExperienceLeg && latestCompletedReason === 'respondent_early_finish'`.
  `allowEarlyFinish` is read **live** from the version's current config, not a snapshot from
  the original early finish — an admin who disables the toggle also revokes reopen for
  sessions that already early-finished under it.
- **Impure gate** — `resolveReopenEligibility` (`app/api/v1/app/questionnaire-sessions/_lib/reopen-eligibility.ts`):
  resolves the three inputs above (current config, experience-leg membership via the report
  enqueue module's `isExperienceLeg`, and the `reason` on the most recent `completed`-type
  session event) and feeds the pure decider. Consumed by both the status route (projecting
  `SessionStatusView.reopenAvailable`) and the lifecycle route (gating the action itself).
- **Seam writer** — `reopenSession` (`app/api/v1/app/questionnaires/_lib/sessions.ts`): its
  own `$transaction`, **not** a `transitionSession` wrapper. Updates status to `active`,
  writes a `reopened` event (`fromStatus: 'completed'`, `toStatus: 'active'`), and reverts a
  currently-`completed` linked invitation back to `opened` (mirrors `transitionSession`'s
  complete-time stamp; never touches `revoked`/`expired`). A defensive `status !== 'completed'`
  check throws `SessionTransitionError` — the ROUTE is expected to have already called
  `resolveReopenEligibility` and refused with 409 before reaching here.
- **Route** — `POST …/questionnaire-sessions/:id/lifecycle` gains a `reopen` action,
  available to **both** authenticated and anonymous respondents (unlike `pause`/`resume`,
  which are signed-in only) — see [session-lifecycle.md](./session-lifecycle.md).
- Re-finishing after a reopen force-regenerates the (1:1) `AppRespondentReport` row rather
  than upserting idempotently — see [respondent-report.md](./respondent-report.md).

## The event log

`AppQuestionnaireSessionEvent` is the append-only trail (`onDelete: Cascade` — it follows
the session). One row per recorded event, `eventType` from `SESSION_EVENT_TYPES`:

| eventType          | when                                                | from/toStatus          |
| ------------------ | --------------------------------------------------- | ---------------------- |
| `paused`           | `active → paused`                                   | active / paused        |
| `resumed`          | `paused → active`                                   | paused / active        |
| `completed`        | `active → completed`                                | active / completed     |
| `abandoned`        | `active\|paused → abandoned`                        | (from) / abandoned     |
| `reopened`         | `completed → active` (early-finish only, see above) | completed / active     |
| `created`          | real respondent session born                        | null / active _(F6.1)_ |
| `cost_cap_reached` | budget hit (non-transition)                         | null / null            |

`resumed` names the resume edge distinctly from the initial `active`; `reopened` likewise
names the early-finish-only reopen edge distinctly from `resumed` (they have different
eligibility and different `from`/`to` pairs), and is the one deliberate, separately-gated
exception to `completed` being terminal — see [Reopen (early-finish only)](#reopen-early-finish-only).
`created` and
`cost_cap_reached` are **non-transition** markers: `created` is reserved for when F6.1
binds a real respondent session (F4.6 doesn't create real sessions — the preview session
is admin-exercise scaffolding); `cost_cap_reached` has its hook now (see below) but is
only fired at the turn boundary in F6.3/F6.5.

`fromStatus`/`toStatus`/`reason`/`metadata` capture the detail; the model is fully
Prisma-modelled (no raw-SQL object), so unlike the session's partial unique index it needs
no drift probe.

## The seam (`_lib/sessions.ts`)

- `transitionSession(sessionId, to, opts?)` — the single writer: read → classify →
  (illegal: throw · noop: return current, no write · apply: update status + write event),
  all in one `$transaction`. Throws `NotFoundError` on an unknown session.
- `pauseSession` / `resumeSession` / `abandonSession` — thin status-specific wrappers.
- `markSessionCompleted` — **moved here from `answer-slots.ts`** (which re-exports it, so
  the F4.5 `/complete` route is unchanged); now routes through `transitionSession`, so the
  accept→submit path writes a `completed` event like every other transition. Still
  idempotent.
- `recordCostCapReached(sessionId, { spentUsd, capUsd })` — writes the non-transition
  `cost_cap_reached` event. The hook F6.3/F6.5 will fire; F4.6 wires it but never fires it.
- `loadSessionResumeState(sessionId)` — the resume read: `{ status, answeredSlots }`.
  Deliberately minimal — coverage / next-question stay in the F4.1/F4.5 context builders
  the caller already uses; per-turn history is F6.1's.

## The route

`POST …/versions/:vid/sessions/:sessionId/transition` — admin-only, body
`{ action: 'pause' | 'resume' | 'abandon', reason? }`.

- Gate order: `withAdminAuth` → body validation → **scope check** (the session must belong
  to this version, and the
  version to this questionnaire — else 404) → seam call.
- **The scope excludes the preview session (`isPreview: false`).** The F4.4/F4.5 preview
  singleton is admin-exercise scaffolding whose lifecycle is intentionally minimal
  (`active` → `completed` via `/complete`); letting `/transition` pause or abandon it would
  brick that version's submit (an abandoned session is terminal, and completing a
  non-active session is illegal). The lifecycle machine is for **real respondent sessions**
  (F6.1); until those exist the route 404s every existing session, and the machine is
  exercised by hand (Vitest) through the seam.
- `resume` returns `loadSessionResumeState`; `pause`/`abandon` return `{ status }`.
- Illegal transition → **409**; unknown session/version → **404**.
- **Completion is not an action here** — accept→submit stays on the F4.5 `/complete` route,
  the single submit entrypoint.
- **No per-flow sub-cap**: a single-transaction transition is cheap, so it inherits only
  the platform's automatic 100/min section cap (proxy.ts).

## What F4.6 does _not_ do (deferred)

- **Turns** (`AppQuestionnaireTurn`, populating `lastUpdatedTurnId`) — F6.1.
- **Real respondent binding** (`respondentUserId`) — P6/P7. F4.6 exercises the machine by
  hand (Vitest) through the seam; the `/transition` route excludes the preview singleton, so
  it goes live once real respondent sessions exist (F6.1).
- **Firing** the cost-cap hook — F6.3/F6.5. F4.6 only wires it.
- The streaming surface and any UI — P6/P7.

## See also

- [`completion-logic.md`](./completion-logic.md) — F4.5, whose `markSessionCompleted` seam
  this generalises into `transitionSession` (and whose `/complete` route stays the submit
  entrypoint).
- [`answer-refinement.md`](./answer-refinement.md) — F4.4, which introduced the
  `AppQuestionnaireSession` / `AppAnswerSlot` tables this builds on.
- [`schema.md`](./schema.md) — the `AppQuestionnaireSessionEvent` model + its migration.
