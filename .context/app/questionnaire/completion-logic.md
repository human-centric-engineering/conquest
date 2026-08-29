# Completion logic (F4.5)

When is a questionnaire "done enough" to submit, and what happens when the respondent
says yes or "not yet"? The fifth of P4's conversational primitives after selection
(F4.1, _which_ question), extraction (F4.2, _what_ was answered), detection (F4.3, _do
the answers conflict_), and refinement (F4.4, _update an answer_). F4.5 is the
**close**: it decides when to offer submission, phrases that offer, and resolves the
respondent's accept/hold — driving the contradiction **completion-sweep** at the moment
of offer.

Built as a pure core + a capability (offer phrasing) + two routes, on top of F4.4's
answer/session persistence.

## Two layers: deterministic gate, LLM phrasing

The split is the heart of F4.5:

1. **Eligibility is deterministic** (`completion/completion-logic.ts`). `assessCompletion`
   decides _whether_ the agent may offer. No LLM, no I/O — pure math over the config
   thresholds plus a required-questions gate.
2. **Phrasing is the LLM's job** (`capabilities/compose-completion-offer.ts`). When the
   assessment is `offer`, the composer writes the natural-language offer (the "agent
   contract"). It never decides whether to offer — only how to say it — so the
   deterministic gate stays authoritative.

This mirrors F4.1's pure-strategy nature for the decision, while keeping the
extractor/detector/refiner capability shape for the wording.

## The assessment

`assessCompletion(ctx: CompletionContext): CompletionAssessment` returns one of
`COMPLETION_KINDS = ['offer','not_ready','blocked_on_required']` (`completion/types.ts`),
with the unmet criteria (`UNMET_CRITERIA`), the coverage, the answered count, the
unanswered required keys, a `capReached` flag, and an `earlyFinishAvailable` flag (the
respondent escape hatch — see below; orthogonal to `kind`).

**Ordering** mirrors selection's `terminalDecision` so the two layers agree:

1. **Cap** — `maxQuestionsPerSession` reached → `offer` (a capped session can always
   submit, even with coverage unmet), flagged `capReached`.
2. **Required gate (the piece selection lacks)** — any unanswered _required_ slot →
   `blocked_on_required`. Checked _before_ the thresholds because weighted coverage can
   clear the bar while a low-weight required slot is still open; a required question is
   mandatory by definition, so coverage alone can't satisfy completion.
3. **Thresholds** — coverage ≥ `coverageThreshold` AND answered ≥ `minQuestionsAnswered`
   → `offer`.
4. Otherwise → `not_ready`, listing `coverage_below_threshold` / `below_min_answered`.

**Reuse, not reinvention.** `assessCompletion` calls the F4.1 coverage helpers
(`coverageRatio`, `answeredCount`, `unansweredQuestions` in `selection/context.ts`) —
whose param type was narrowed to a structural `CoverageContext` so completion can pass
its own context without dragging in selection-only fields (`round`, `recentMessages`).
`SelectionContext` still satisfies it, so every F4.1 caller is unaffected, and the
preview routes reuse `buildSelectionContext` directly — no new context builder. The same
`COVERAGE_EPSILON` guards the threshold comparison against float-sum drift.

## Two coverage figures: strict gate vs. graded bar

The assessment carries **two** coverage numbers, deliberately separate:

- **`coverage`** — the strict **gate** figure. Before it runs the coverage helpers, `assessCompletion`
  drops every answer scored **below `answerConfidenceFloor`** (default `0.5`); unscored (`null`)
  answers are authoritative and always kept. So an opportunistic/tentative capture (an
  [opportunistic fill](./opportunistic-fill.md) is seeded at ≤ `0.45`, one notch under the floor)
  counts for **nothing** toward coverage, the min-answered gate, or a required question until a later
  turn corroborates it above the floor. This is what `kind` / the Submit affordance keys off.
- **`displayCoverage`** — the **progress-bar** figure only, never a gate input. Computed by
  `gradedCoverage(questions, answered, floor)` over the **full, ungated** answer set: a confirmed
  answer (confidence ≥ floor, or `null`) earns full weight; a below-floor tentative answer earns
  `TENTATIVE_ANSWER_CREDIT` (`0.5` — half credit) of its weight. Where a question has several answer
  rows its best credit wins.

**Why two.** With only tentative captures, strict `coverage` is `0` — but the respondent has plainly
made progress, so a flat `0% completed` bar reads as a bug (it looks like nothing landed even as the
panel shows "context areas captured"). `displayCoverage` gives partial credit so the bar shows real
momentum, while the gate stays strict so a session can't submit on unconfirmed guesses. The
respondent `SessionProgressBar` reads `displayCoverage`; `canSubmitSession` reads `kind`. With the
floor at `0` nothing is below it, so `displayCoverage === coverage` and the two collapse — preserving
the "floor off ⇒ prior behaviour" contract. The **data-slot** submit path overrides only `kind` (all
questions answered) and keeps both coverage figures from `assessCompletion`, so the bar behaves the
same in either mode (`app/api/v1/app/questionnaire-sessions/_lib/session-status.ts`).

### And a third figure the bar actually draws: `progressPct` (F17.33)

`displayCoverage` is honest about _now_. It is not, on its own, safe to draw, because
[Conditional Topics](./conditional-topics.md) can **widen** an interview after it has started — the
plan landing at the end of the opening (every conditional-topics session) and a respondent
amendment both add questions to the in-scope set, which is the denominator. Recomputed honestly the
percentage therefore **falls**, at the exact moment the interviewer is announcing what it will now
cover.

Two rules answer that, and they are deliberately separate:

1. **`progressQuestions` — the denominator is chosen so the figure moves the right way.** Optional
   on `CompletionContext`, defaulting to `questions`, and different in exactly one case: a
   Conditional Topics session **before its plan exists**, where it is the full candidate set rather
   than the always-run phases. The bar then under-reads during the opening and steps **up** when the
   plan excludes topics. Built once in `buildTurnContext` beside the scope filter, so no consumer
   can pick the wrong list. **Every gate figure stays on `questions`** — this changes what the
   respondent is shown, never what they are allowed to do.
2. **`progressFloorPct` — the figure never goes backwards.** `resolveDisplayedProgress`
   (`completion/progress.ts`) returns `max(computed, floor)`, and the floor is banked on the **turn**
   path (both orchestrators, beside the milestone ledger) and **applied** on the read path
   (`buildSessionStatusView`), because a GET must not write and nothing moves the coverage between
   turns anyway. Capped at **99**: only a genuinely complete interview may ever show 100%, so a
   widened session stalls one point short rather than claiming to be finished while the interviewer
   is still asking.

The floor is **presentation state, never a measurement.** Nothing analytic, no report and no export
reads it; `displayCoverage` remains the un-ratcheted truth for all of those, and the **milestone
ledger is deliberately fed the un-ratcheted figure too** — a banner must be spent on a threshold the
respondent genuinely reached, not on one a presentation floor was holding.

Milestones need no widening logic of their own: `resolveMilestoneCrossing` reads the same graded
coverage the bar does, so rule 1 fixes them for free. That is the reason this is a fix to the number
rather than a settings-conflict warning about the combination — see
[`f17-progress-under-widening.md`](../planning/features/f17-progress-under-widening.md) §7.1.

**A session that ends before its plan is decided reads low**, because it was measured against the
whole instrument. That is honest — they did finish early — and the submit gate is untouched.

There is no `completionConfig` blob and no `sweep_only` mode (the development plan's
sketch): F4.5 maps onto the committed flat config fields (`minQuestionsAnswered`,
`coverageThreshold`, `maxQuestionsPerSession`) and the existing
`shouldRunDetection(mode, windowN, 'completion-sweep')`.

## Accept / hold resolution

`resolveCompletion(action, assessment, sweep): CompletionResolution`
(`COMPLETION_ACTIONS = ['accept','hold','finish_early']`) maps the respondent's reply plus
the completion-sweep result onto one of:

- **`submit`** — accepted and clean: the sweep didn't run (mode off / detection
  disabled) or found nothing. The session should transition `active → completed`.
- **`hold_for_review`** — accepted, but the completion-sweep found contradictions. Do
  **not** auto-submit: surface the conflicts for reconciliation (F4.4), then re-offer.
  The session stays `active`. (Consistent with F4.3 never auto-overwriting.)
- **`continue`** — the respondent held, _or_ accept was attempted while ineligible
  (e.g. `blocked_on_required`). Keep asking; the session stays `active`.

The sweep's _decision_ to run is pure (`shouldRunDetection`); its _execution_ (LLM
dispatch) is impure and happens in the route, which passes the resulting
`contradictionCount` back in so the resolver stays pure and unit-testable.

## Respondent-controlled early finish (the escape hatch)

The `offer` above is the **agent's** decision that the questionnaire is done enough. The
early-finish feature is the **respondent's** parallel right to end whenever they like once
they've crossed an admin-set minimum — even below the agent's thresholds, and **even with
required questions still open** (a deliberate escape hatch, unlike `offer`).

It is **config-only** (no platform flag), three fields on `AppQuestionnaireConfig`
(`configuration.md`):

- `allowEarlyFinish` (bool, default `true`) — turns the feature on. Defaulting on is safe
  because completing this way is no longer a dead end for the respondent — see the reopen
  note below.
- `earlyFinishMinCoverage` (0–1, default `1.0`) — weighted-coverage bar. Stored as a fraction but
  **edited as a whole percent** (0–100) in `config-editor.tsx` (`pctString` / `fractionFromPct`);
  the default `1.0` (100%) surfaces the control only once the respondent has effectively completed
  the questionnaire — admins lower it to let them finish sooner.
- `earlyFinishMinQuestions` (int ≥0, default `0` = **off**) — answered-count bar; off by default so
  the coverage bar gates alone.

The two bars have **no priority** — the control unlocks on whichever the respondent reaches first
(the editor states this inline; `0` on either axis = "off / not a criterion").

`assessCompletion` computes `earlyFinishAvailable` independently of `kind` via the pure
`isEarlyFinishAvailable(config, coverage, answered)` (exported from `completion-logic.ts`,
also reused by the data-slot orchestrator's inline assessment so the two can't drift):

> `allowEarlyFinish` AND — both bars `0` ⇒ available from the start; else coverage ≥
> `earlyFinishMinCoverage` (when set) **OR** answered ≥ `earlyFinishMinQuestions` (when
> set). A bar of `0` is "not a criterion on that axis", so it never trivially satisfies the
> OR — a single configured bar gates alone.

`resolveCompletion('finish_early', assessment, sweep)` → `submit` when
`earlyFinishAvailable`, else `continue`. It **runs no sweep** (a deliberate bail; live
contradiction detection already happened during the chat) and **ignores the
required/threshold gate**.

**Surfacing.** `buildSessionStatusView` projects `earlyFinishAvailable` into the
respondent status (`GET …/status`); `canFinishEarly(view)` (active + available) mirrors the
submit gate. The respondent UI shows a persistent **Continue / Finish up** control
(`components/app/questionnaire/lifecycle/early-finish-control.tsx`) once unlocked — but the
full `CompletionOffer` takes precedence when both are available. The submit route
(`POST …/questionnaire-sessions/:id/submit`) accepts an optional `{ early?: boolean }` body;
`early: true` resolves via `finish_early` and completes with reason
`respondent_early_finish` (vs `respondent_submit`).

**Completing early is no longer strictly terminal.** The `respondent_early_finish` reason is
what a later "Continue answering" reopen checks for — see
[`session-state-machine.md`](./session-state-machine.md#reopen-early-finish-only) for the
full mechanism. A session completed via the ordinary `respondent_submit` path stays exactly
as terminal as it always was.

## The offer composer (capability, agent)

- **`AppComposeCompletionOfferCapability`** (`capabilities/compose-completion-offer.ts`)
  — a `BaseCapability` running one provider-agnostic structured LLM call (call → parse →
  retry-once-at-temp-0 → cost-sum). Returns a `CompletionOffer` `{ offerMessage,
coveredSummary, remainingNote? }`. The recap is built from question **prompts only**
  (no respondent values); `processesPii = true` (the recap echoes prompts + recent
  messages) with a counts/flags-only `redactProvenance`. Dispatched by slug
  `app_compose_completion_offer`.
- **Completion agent** (`app-questionnaire-completion-agent`, seed 015) — distinct from
  the extractor (006), detector (009), and refiner (012): it phrases the close rather
  than extracting or judging, with its own persona and `monthlyBudgetUsd`. Resolves the
  `chat` tier; ships with empty model/provider (dynamic resolution).
  `visibility: 'internal'`.
- **Always on.** Composing the offer spends an LLM call, but there is no feature flag to
  check — the composer runs whenever the deterministic assessment is `offer` (see below).

The completion-sweep itself adds **no new capability**: it reuses F4.3's
`app_detect_contradictions`, which runs per the version's `contradictionMode` config.

## The two routes

Both admin-only.

### `POST …/versions/:vid/completion-status` — read-only assessment (+ optional offer)

Gate order: `withAdminAuth`
(401/403) → `validateRequestBody` (400) → `buildSelectionContext` (404 version) →
`assessCompletion`. When the assessment is `offer`:
`completionLimiter` (429, 60/min per admin) → load the completion agent (404 if
unseeded) → dispatch the composer (fail-soft) → include the `offer`.

Body: `{ answered: [{ key, confidence? }], recentMessages?, sessionId? }`. Response:
`{ assessment, offer?, diagnostic? }`. **Persists nothing.**

The deterministic assessment is free and useful on its own, so when the assessment isn't
`offer` the route simply returns the assessment without a composed `offer` — only the paid
LLM phrasing is skipped. A failed composition is fail-soft (assessment + `diagnostic`, no
offer, never a 5xx).

### `POST …/versions/:vid/complete` — the accept/hold action (persists)

Gate order: `withAdminAuth` → `validateRequestBody` →
`completionLimiter` → `buildSelectionContext` (404 version) → `assessCompletion` → seed
the supplied answers into the preview session (idempotent) → on an eligible `accept`,
run the sweep → `resolveCompletion` → on `submit`, `markSessionCompleted`.

Body: `{ action: 'accept'|'hold', answers: [{ key, value, confidence?, provenance?,
turnIndex? }], mode?, windowN?, sessionId? }`. Response: `{ assessment, resolution,
sessionId, status, findings?, diagnostic? }`.

**The completion-sweep** runs only on an eligible `accept` (assessment `offer`):
`buildContradictionContext` over the supplied answers → `shouldRunDetection(mode,
windowN, 'completion-sweep')` (which always compares **all** answers for modes
flag/probe) → if it should run, dispatch
`app_detect_contradictions`. A failed or `off`-mode sweep is **fail-soft: treated as
clean** so a wrap-up never 5xxs (a `diagnostic` is returned). Fewer than two resolvable
answers → no sweep (nothing can contradict). The dispatch sends **only the answered
slots** (an unanswered slot can't contradict and is never rendered into the detector
prompt), so the detector's `MAX_CONTRADICTION_SLOTS` cap tracks the answer count, not the
questionnaire's size; if even the trimmed input exceeds the detector's caps the sweep is
**skipped with an explicit `sweep_skipped_oversized` diagnostic + warn log** rather than a
silent doomed dispatch.

**Persistence** (the F4.4 seam, extended): the route seeds answers via
`getOrCreatePreviewSession` + `upsertAnswerSlot`, and on a clean `submit` calls the new
`markSessionCompleted(sessionId)` (`_lib/answer-slots.ts`) to transition the session
`active → completed` (idempotent). `getOrCreatePreviewSession` is **race-safe**: a raw-SQL
partial unique index (`idx_app_questionnaire_session_preview_per_version`, WHERE
`isPreview` = true; migration `20260605141500`, drift-probed in `lib/app/db-drift.ts`)
makes a concurrent duplicate create fail with P2002, which the seam catches and resolves to
the winning row — so two simultaneous first-touch requests can't split a version's preview
answers across two sessions. `hold` and `hold_for_review` leave it `active`.
`accept` while `blocked_on_required` does **not** submit. There is no
`AppQuestionnaireSessionEvent` table yet (F4.6) — the `status` column is F4.5's only
audit surface.

## Who consumes it (F4.6 seam)

The streaming engine (F4.6) wires the live per-turn loop: each turn it calls
`assessCompletion`; when eligible it composes the offer for the agent to speak; on the
respondent's reply it runs the completion-sweep and `resolveCompletion`, then transitions
the session via the same `markSessionCompleted` seam — populating `turnIndex` /
`lastUpdatedTurnId` from the real turn loop and (once it exists) writing a session event.

## See also

- [`selection-strategies.md`](./selection-strategies.md) — F4.1, whose `terminalDecision`
  ordering and coverage helpers F4.5 reuses (via the narrowed `CoverageContext`).
- [`contradiction-detection.md`](./contradiction-detection.md) — F4.3, whose
  `shouldRunDetection('completion-sweep')` scheduler and `app_detect_contradictions`
  capability F4.5 drives at the moment of offer.
- [`answer-refinement.md`](./answer-refinement.md) — F4.4, the persistence foundation and
  the reconciliation path a `hold_for_review` feeds back into.
- [`configuration.md`](./configuration.md) — the completion config fields
  (`minQuestionsAnswered`, `coverageThreshold`, `maxQuestionsPerSession`).
