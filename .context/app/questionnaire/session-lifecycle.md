# Session lifecycle UX (F7.3)

> The respondent-facing surface for the session's lifecycle: pause/resume, the
> completion-offer → submit flow, and the cost-cap state. (The anonymous-mode indicator started
> here too; it now lives on the brand band — see the component list below.)
> Built on the F4.6 state machine, the F4.5 completion logic, and the F6.3 cost cap — F7.3
> is the **respondent's** window onto states the backend already models.

## The gap it closes

Before F7.3, a live respondent session had **no path to `completed`**. The orchestrator
streams a completion _offer_ ("Would you like to submit?") as plain prose, but nothing
recorded the acceptance — the only `completed` transition was the admin-only `/complete`
preview/refine route. F7.3 adds the respondent submission flow and surfaces the lifecycle
states that were otherwise invisible to the person taking the questionnaire.

## Data seam — read, not stream frames

The F6.1 SSE stream emits only `start/content/warning/done/error`. Rather than reopen that
contract, F7.3 follows the same decision as the F7.2 answer panel: a **status read endpoint
refetched on turn-settle**, plus two mutations.

| Endpoint                                                | Who                                                    | Purpose                                                     |
| ------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `GET /api/v1/app/questionnaire-sessions/:id/status`     | both respondent kinds                                  | `SessionStatusView`: completion + cost tier + anon + reopen |
| `POST /api/v1/app/questionnaire-sessions/:id/lifecycle` | `pause`/`resume` **signed-in only**; `reopen` **both** | `{ action: 'pause' \| 'resume' \| 'abandon' \| 'reopen' }`  |
| `POST /api/v1/app/questionnaire-sessions/:id/submit`    | both respondent kinds                                  | accept → `completed` (the sole respondent path)             |

All three reuse `resolveTurnAccess` (authed owner OR a valid anonymous `X-Session-Token`).
Gate order is the house pattern: **load → access (401/403) → action**.

### `SessionStatusView` (respondent-safe projection)

`buildSessionStatusView` (pure, `lib/app/questionnaire/session/status-view.ts`) maps the
F4.5 assessment + F6.3 cost tier + F4.6 status into:

```ts
{
  status,                          // active | paused | completed | abandoned
  completion: { kind, coverage, answeredCount, requiredUnansweredKeys, capReached },
  cost: { tier } | null,           // coarse tier ONLY — never the raw USD spend
  anonymous,
  reopenAvailable,                 // completed via early-finish AND still reopenable — see below
}
```

It's deliberately narrow (same quiet-signal discipline as the panel's confidence dot):
authoring internals and the raw spend are never projected. `cost` is `null` unless a
positive budget is configured — otherwise a soft-cap hint would mislead. A `hard` tier on a `paused` session is the tell that the pause was
budget-driven (terminal) vs. a respondent pause (resumable). `canSubmitSession(view)` is the
shared derivation — `status === 'active' && completion.kind === 'offer'` — used by both the
UI and the submit route, so the button and the endpoint can't disagree.

The `_lib/session-status.ts` seam does the one DB read: it reuses `buildTurnContext` (so the
assessment is byte-identical to the live turn's), sums spend via `sumSessionTurnCost`, and
grades with `classifyCostCap`.

## Submit: the gate is upstream

The submit endpoint re-asserts eligibility through the F4.5 `resolveCompletion('accept', …,
{ run: false })` — **no completion sweep**, because contradictions already surface live during
the chat (F4.3). A required question can't be outstanding at submit time: `assessCompletion`
only returns `offer` once the required gate is clear, so the Submit affordance never appears
while a required question is blank. The **one exception** is the existing F4.5 behaviour that a
question-cap-reached session can always submit (cap is a hard "stop here"), honoured as-is.

Responses: idempotent `200` on an already-completed session; `409 SUBMIT_NOT_READY` when not
offerable; `409 SESSION_NOT_ACTIVE` for a paused/abandoned session (the state machine forbids
`paused → completed` — resume first).

## Pause: signed-in only

Pause/resume drives the same `_lib/sessions.ts` seam as the admin `/transition` route, but is
restricted to authenticated respondents. A no-login session lives entirely in the browser tab
(its token is client-only and lost on reload), so a deliberate pause has nowhere durable to
resume from — an anonymous caller is refused `403 PAUSE_NOT_PERMITTED`. Anonymous respondents
still see system-driven states (budget pause, completed) via `GET …/status`. The hook mirrors
the rule in `canPause`/`canResume` so the UI never offers an action that would 403; a
budget-paused session (`cost.tier === 'hard'`) is **not** resumable (it would re-cap at once).

**`reopen` is a separate action with its own (looser) access rule** — see
[Reopen: both respondent kinds](#reopen-both-respondent-kinds) below. It is NOT swept into the
anonymous-refusal branch above.

## Reopen: both respondent kinds

The early-finish "Continue answering" control (on `SessionComplete`, the report screen) lets a
respondent who finished via the early-finish escape hatch go back into the conversation.
Unlike pause/resume, `reopen` is available to **anonymous respondents too**: it's an
immediate, same-tab action taken while the access token is already in hand (the respondent is
looking at the report page in the same session), not a durable resume-in-a-future-visit —
which is specifically what the pause/resume anonymous restriction guards against.

Gated server-side by `resolveReopenEligibility` (completed via the early-finish escape hatch,
`allowEarlyFinish` still on, not an experience-run leg) — see
[`session-state-machine.md`](./session-state-machine.md#reopen-early-finish-only) for the full
mechanism (pure decider, seam writer, the `reopened` event, and why it deliberately isn't a
`LEGAL_TRANSITIONS` edge). `useSessionLifecycle` exposes `canReopen`/`reopen()`, mirroring
`canResume`/`resume()`'s shape but **not** anonymous-gated. On success `reopen()` pushes
`stream.applyStatus('idle')`, which — together with the hook's own refetch flipping
`lifecycle.view.status` — makes `SessionComplete` unmount and the chat surface re-render, the
same fallthrough `session-workspace.tsx` already relies on for a page-reload landing on a
completed session.

## UI wiring

`SessionWorkspace` lifts a third hook, `useSessionLifecycle`, alongside the F7.2 stream + panel
hooks. The shared stream's `onTurnSettled` now refetches **both** the panel and the status
view. Lifecycle actions change status server-side, then push the authoritative status into the
shared stream via `stream.applyStatus(...)` (so the composer enables/disables in lockstep) and
refetch.

- **`SessionLifecycleBar`** — a quiet strip above the chat, in **two lines split by kind**, each
  of which drops out when it has nothing to carry:
  - **Status** — the coverage bar, the session ref chip, the transcript download. Facts about the
    session; none of them changes what is on screen.
  - **Controls** — the surface switcher on the left (via `leading`), then the cost hint, the paused
    notice and any action error, then the tools cluster on the right (via `trailing`: text size,
    interviewer chip, review trigger) with Pause/Resume.

  The split is not cosmetic. Everything used to right-align into one wrapping `ml-auto` cluster, so
  on a laptop the controls fragmented into three ragged lines above the conversation. Moving the
  ref and download to the status line is what buys the controls a single row back; anchoring the
  switcher on the left gives the row two cohesive clusters, so the worst case when it genuinely
  runs out of width is two tidy lines rather than three ragged ones. The review trigger's
  "· N% complete" suffix was dropped from the visible button for the same reason — under a bar
  already reading "0% completed" it printed the same fact twice, on the row with least room to
  spare. It survives in the control's `aria-label`, where there is no bar to glance at.

  Renders nothing when there's nothing to say. The **anonymity notice is not on this strip** — it rides the brand
  band above the conversation (`BrandThemeProvider`), one quiet line under the questionnaire
  title, aligned with it, so it costs no row of its own. The admin session viewer has no band,
  so it shows an `Anonymous` badge in its own header row instead. Its `SessionProgressBar`
  (`coverage={view.completion.displayCoverage}`) always renders once there's a status view; the
  "N% completed" text beside it is a separate `showProgressPercentText` prop (config default
  `true`), threaded from each respondent page down through `SessionWorkspace` — see
  [configuration.md § Progress display & completeness milestones](./configuration.md#progress-display--completeness-milestones-f-progress).

- **`CompletionOffer`** — a Submit CTA above the chat, shown when `canSubmit`. "Keep going"
  dismisses it; it reappears on the next settle if still offerable.
- **`SessionComplete`** — replaces the workspace on `completed`: a calm, themed confirmation
  (distinct in tone from `ChatErrorPanel`'s blocking states), acknowledging the captured count.
  When `canReopen` (early-finish origin, config still on, not an experience leg), a secondary
  "Continue answering" control calls `onReopen` — see [Reopen: both respondent kinds](#reopen-both-respondent-kinds).

The authed page SSR-seeds the status view (`loadSessionStatus`) and maps it to the surface's
initial chat status — a budget-paused session (`hard` tier) becomes terminal `cost_capped`, a
respondent pause becomes resumable `not_active`, `completed` shows the confirmation. The
anonymous page can't SSR (the token is client-only), so the hook fetches on mount.

## Gating

Always on — part of the always-on respondent surface. No flag, no migration (the
`completed`/`paused`/`resumed` statuses and events already exist from F4.6).

## See also

- [`session-state-machine.md`](./session-state-machine.md) — the F4.6 lifecycle + cost cap.
- [`per-turn-orchestrator.md`](./per-turn-orchestrator.md) — the turn loop + the route table.
- [`answer-slot-panel.md`](./answer-slot-panel.md) — the F7.2 panel sharing `onTurnSettled`.
