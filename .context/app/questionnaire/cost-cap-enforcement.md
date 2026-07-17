# Cost-cap enforcement (F6.3)

Per-session USD budget enforced at the **turn boundary** of the live `/messages` loop. A
runaway conversation can't burn unlimited LLM spend: as the session's accumulated cost
approaches its budget the agent is nudged to wrap up, and once it hits the budget the turn
is refused and the session auto-paused.

This builds on the F4.6 session state machine (which wired but never fired
`recordCostCapReached`) and the F6.1 per-turn orchestrator. It reuses the existing
`AppQuestionnaireConfig.costBudgetUsd` field — **no schema change, no migration**.

## The two boundaries

`classifyCostCap(spentUsd, capUsd)` (`lib/app/questionnaire/session/cost-cap.ts`, pure)
grades the spend so far against the budget:

| Tier   | Condition            | Behaviour                                                                              |
| ------ | -------------------- | -------------------------------------------------------------------------------------- |
| `none` | uncapped, or `< 90%` | Run the turn normally.                                                                 |
| `soft` | `≥ 90%` and `< 100%` | Run the turn, but **offer completion early** + nudge a wrap-up in the offer prose.     |
| `hard` | `≥ 100%`             | **Refuse** the turn (HTTP **402**), **auto-pause** the session, write the audit event. |

A `null` (or non-positive) `costBudgetUsd` is uncapped — `none` always. The soft ratio is
`SOFT_CAP_RATIO = 0.9`.

## Cost source — summed turn cost

"Spend so far" is `sumSessionTurnCost(sessionId)` (`_lib/turns.ts`): a Prisma `_sum` over
`AppQuestionnaireTurn.costUsd` for the session. This is the spend **before** the current
turn runs (turn-boundary semantics — the current turn's cost is recorded afterward by
`recordTurn`, so it's caught at the next boundary).

For that sum to be meaningful, F6.3 also closed the F6.1-deferred per-turn cost aggregation:
the extract / detect / refine capabilities now surface their real LLM `costUsd` on their
`data` payload (computed from the same `runStructuredCompletion` result they already log to
`AiCostLog`), the live invokers read it (`turn-invokers.ts`) instead of stubbing `0`, and the
orchestrator sums it into `TurnResult.costUsd`. The offer-stream composer and adaptive
selection already returned real cost. So `AppQuestionnaireTurn.costUsd` is now the true
per-turn spend.

## Where enforcement runs

In the `/messages` route (`app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`),
**pre-stream**, after the status-active gate and body validation, before any per-turn work:

1. Skip entirely unless `costBudgetUsd` is set — a configured budget is the only gate.
2. `spent = sumSessionTurnCost(sessionId)`; `tier = classifyCostCap(spent, cap)`.
3. **hard** → `recordCostCapReached(…, tier: 'hard')`, `pauseSession(…, { reason: 'cost_cap' })`,
   return `errorResponse('Session cost budget exhausted', { code: 'COST_CAP_REACHED', status: 402, details: { spentUsd, capUsd } })`. The turn never runs. Every later turn then fails
   the existing `status === 'active'` gate (the session is paused), so the cap locks naturally.
4. **soft** → set `costPressure: 'soft'` on the `TurnState`; write the soft event **once**
   (`hasCostCapReachedEvent(sessionId, 'soft')` dedupes — the soft tier persists across every
   turn between 90% and 100%, so a naive write would spam the audit trail).

## Soft cap in the orchestrator

`costPressure: 'soft'` on the `TurnState` makes the pure core (`orchestrator.ts`):

- **Bias toward offering early** — a `not_ready` assessment (thresholds merely unmet) with
  `answeredCount > 0` is responded to as an offer instead of asking the next question. It
  **never** bypasses the required-questions gate (`blocked_on_required` stays authoritative)
  and **never** offers on an empty session.
- **Tag the offer prose** — `OfferComposeInput.costWrapUp` is set, so the streaming offer
  composer (`offer-stream.ts`) appends a brief "approaching this session's limit, wrap up"
  instruction to its system prompt.

This is the cost cap (`costBudgetUsd`), distinct from `assessment.capReached` (the F4.5
`maxQuestionsPerSession` question-count cap) — two separate concepts.

## Audit events

Both boundaries write a non-transition `cost_cap_reached` `AppQuestionnaireSessionEvent`
with `metadata: { spentUsd, capUsd, tier }`. The hard-cap auto-pause additionally writes its
own `paused` transition event (via `pauseSession`). `recordCostCapReached` never changes
status itself.

## The only gate: a configured budget

Cost-cap enforcement is **always on** — there is no feature flag to check. The single gate is
the per-version `costBudgetUsd` config: enforcement runs whenever a version sets a positive
budget, and is a no-op (`none` tier, no budget check) when the budget is `null`/non-positive.
Because this is a behaviour _inside_ the already-live `/messages` loop, there is no route to
404 — the budget check simply doesn't fire without a configured cap. The budget is the version
author's opt-in, exactly as it was the real second half of the old gate.
