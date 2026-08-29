---
feature: F17.33
title: Progress, and what the respondent is told, when the interview grows
phase: P17 — Conditional Topics
status: phase A shipped (2026-08-29); B–D in progress. Decisions still needed at §5.4 (which extractor) and §6.3 (announce gating)
owner: TBD
deps: F17.1 (the plan), F17.6 (respondent amendment), F-progress (milestone banners), F4.5 (completion assessment)
opened: 2026-08-29
docs: .context/app/questionnaire/conditional-topics.md, .context/app/questionnaire/completion-logic.md, .context/app/questionnaire/opportunistic-fill.md
related: .context/app/planning/features/f17-mid-interview-triggers.md
---

# Progress, and what the respondent is told, when the interview grows

Conditional Topics narrows an interview, and then — at least twice — **widens** it again. Three
things the product does are written on the assumption that the question set is fixed for the
session, and all three misbehave the moment it is not:

1. **The progress bar runs backwards** at the exact moment the interviewer announces what it will
   cover next.
2. **The respondent is told almost nothing** about a section that appears mid-conversation.
3. **What they already said about the new section is thrown away** — it was out of scope when they
   said it, so the extractor never saw the question it answered.

This spec fixes all three. They are one spec because they share a trigger (scope widening), a
migration, and — for (1) and (3) — the same arithmetic: (3) is what makes (1) smaller.

## 1. Why, with the arithmetic

### 1.1 The denominator is the respondent's interview, and it moves

`buildTurnContext` is the choke point (`turn-context.ts:505`): it filters `questions`, `slots` and
`dataSlots` through `buildSessionScope`, and everything downstream reads the filtered lists —
targeting, the end-of-run sweep, completion, contradiction candidates, and **the progress figure**.
`assessCompletion` grades `ctx.questions` (`completion-logic.ts:125`), the status endpoint projects
that onto `SessionStatusView.completion.displayCoverage` (`session-status.ts:50` →
`status-view.ts:119`), and `SessionProgressBar` draws it in two places.

So the bar's denominator is whatever is in scope right now. Scope widens twice:

| Moment                    | Before                        | After                               | How often                                    |
| ------------------------- | ----------------------------- | ----------------------------------- | -------------------------------------------- |
| **The plan lands**        | opening + core + closing only | plus every seated conditional topic | **every** conditional-topics session         |
| **Respondent amendment**  | the plan                      | plus one topic at `full` depth      | when `allowRespondentAmendment` is on        |
| _(Mid-interview trigger)_ | _the plan_                    | _plus one topic_                    | _not built — see f17-mid-interview-triggers_ |

The first is the one that matters, and it is not the one this started as a question about.
`plan: null` on an enabled version is **not** full scope — it is deliberately the always-run phases
only. So the bar climbs through the opening against a small denominator and then drops:

```
opening done, pre-plan:   5 answered / 17 always-run          = 29%
planner seats 3 topics:   5 answered / 38 in the interview    = 13%
```

The respondent watches the bar go backwards in the same beat as _"based on what you've said I want
to go deeper on pipeline and forecasting"_. The announcement is doing its job; the number is
contradicting it.

### 1.2 Milestone banners inherit the same defect, in a worse form

`resolveMilestoneCrossing` is already safe against coverage moving **down** — the ledger fires each
threshold once and never re-announces below the highest announced (`milestones.ts:96`), precisely
because coverage is not monotonic. What it cannot defend against is announcing a threshold that was
only ever true of a **fiction**: crossing 50% against the 17-question pre-plan denominator, banked
permanently, on an interview that turns out to have 38 questions. The banner is spent, the ledger
means it can never fire again, and the figure it stated was wrong when it was said.

That is the argument for fixing the number rather than warning about the combination: **milestones
read the same figure the bar does, so they are fixed for free and need no separate mechanism.**

### 1.3 An answer given before a topic was in scope is not captured

Extraction candidates come from the scoped list. The route narrows `loaded.slots` (which is
`scopedSlots`) further before handing it to the extractor (`messages/route.ts:620–651`), so a
question that was out of scope on the turn it was answered was **never a candidate**. When the plan
then seats that question's topic, the transcript already contains the answer and the answer slot is
empty — and the interviewer asks it again.

This is not a rare edge. The opening is designed to make the respondent talk broadly about their
situation; the planner then seats topics _because of what they said_. The overlap between "what
they said in the opening" and "what the seated topics ask about" is not incidental — it is the
selection criterion.

### 1.4 What the respondent hears today

Both announcements ride the one-turn briefing seam into the phraser, matched on `atTurn`. The
plan's is the model's own `respondentMessage`, gated by `conditionalTopics.announce`
(`guardrails.ts:283`). The amendment's is `amendmentBriefingLine` (`amendment.ts:215`), which says:

> _"…acknowledge that briefly and warmly in your own words — you will now also cover {label}. Do not
> apologise, do not explain how the interview decides what to ask, and do not mention plans, topics,
> or scope."_

It names the topic and stops there: no sense of how much is coming, and no reason — even though the
respondent's own request is sitting on the record in `PlanAmendment.request`.

## 2. The one-line architecture

> **The gate measures the interview as it is. The bar makes a promise, and a promise does not run
> backwards.**

Everything in §4 follows from separating those two figures, which are currently the same number
doing both jobs.

## 3. Invariants — what this must not become

1. **No gate changes.** `assessCompletion`'s `coverage`, `answeredCount`, the required-question
   gate, the cap and `earlyFinishAvailable` are untouched. Only `displayCoverage` and the milestone
   input move. A respondent must not become able to submit earlier because a bar was made kinder.
2. **The ratchet is presentation, never a measurement.** The stored floor is UI state. No analytic,
   report, cohort figure or export ever reads it.
3. **The ratchet never claims completion.** 100% is a claim that nothing is left, and only the true
   computed figure may make it (§4.3).
4. **The re-read only ever gap-fills.** It never overwrites an answer, never clears one, never
   raises confidence above the opportunistic ceilings, and never touches a question that was
   already in scope. Same rule, and the same reasons, as `reconcileChatDataSlotFills`.
5. **Scope still only ever widens.** Nothing here removes a topic, re-plans, or re-ranks. This spec
   reacts to widening; it never causes one.
6. **Off stays off.** A version with `conditionalTopics.enabled = false` must reach none of this.
   `progressQuestions` collapses to `questions`, the ratchet floor never moves off 0, and the
   re-read is never called. The F17 equivalence test in `turn-context.test.ts` covers the shape;
   this spec adds the figures to it.

## 4. Phase A — make the number honest

Two rules. Neither needs a model call, and together they mean the bar cannot move backwards for any
cause of widening, including the one that does not exist yet.

### 4.1 Pre-plan, count the whole candidate set

`turn-context.ts` holds the unscoped `questions` one line above the filter, so this costs nothing.
Add a third list to the turn-context base:

```ts
/**
 * The denominator for the PROGRESS FIGURE only — never a gate input.
 *
 *  - scope inactive          → `questions` (identical; this feature is inert)
 *  - scope active, no plan   → the FULL candidate set: every conditional topic is still possible,
 *                              so counting only the always-run phases states a total that is about
 *                              to grow. Counting everything states one that can only shrink.
 *  - scope active, planned   → `scopedQuestions`: this respondent's interview, which is the truth.
 */
progressQuestions: QuestionSlot[];
```

The bar then **under**-reads during the opening and steps **up** when the plan excludes topics.
Wrong in the safe direction, and the plan-time cliff disappears without a ratchet being involved at
all.

Threading, three call sites:

| Where                                     | Change                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `completion/types.ts` `CompletionContext` | `progressQuestions?: …` — **optional, defaulting to `questions`**                     |
| `completion-logic.ts:125`                 | `gradedCoverage(ctx.progressQuestions ?? ctx.questions, ctx.answered, floor)`         |
| `data-slot-orchestrator.ts:573`           | grade against `effective.progressQuestions` (this path calls `gradedCoverage` itself) |

Optional-with-a-fallback is deliberate here, against the house preference for required fields: a
call site that forgets to thread it keeps **today's** behaviour rather than silently widening a
denominator. `assessCompletion` has five callers, two of which (`complete/route.ts`,
`completion-status/route.ts`) are admin-side previews with no session and therefore no plan.

`orchestrator.ts:369` needs nothing — it feeds `assessment.displayCoverage`, which is already fixed
by the line above. Keep the `questionCount` guard argument agreeing with the list actually graded,
so the "empty version" short-circuit and the figure can't disagree.

### 4.2 Ratchet the displayed figure

```prisma
// F17.33. Presentation state, not a measurement: the highest whole-percent progress figure this
// session has ever displayed. The bar shows max(computed, this) so a scope widening can never make
// it run backwards. Banked on the TURN path (beside raisedMilestones); the read path applies it and
// never writes. Nothing analytic reads it. Capped below 100 — see resolveDisplayedProgress.
progressFloorPct Int @default(0)
```

New pure module `lib/app/questionnaire/completion/progress.ts`, sibling to `milestones.ts` and
shaped like it — the same "both pipelines or the feature silently does nothing on one path"
argument applies:

```ts
export interface ProgressOutcome {
  /** What the bar shows. */
  pct: number;
  /** The new floor to persist, or `undefined` when it did not move (leave the column alone). */
  progressFloorPct: number | undefined;
}

export function resolveDisplayedProgress(computedPct: number, floorPct: number): ProgressOutcome;
```

**Where each half runs.** The turn path banks (both orchestrators, beside the `raisedMilestones`
write); the read path (`session-status.ts:50`) reads the stored floor and applies the `max` for
display. A GET never writes, and it does not need to: between turns nothing moves the coverage.

`SessionStatusView.completion` gains `progressPct: number` (a whole percent, already ratcheted).
The bar's two render sites (`session-workspace.tsx:589`, `session-lifecycle-bar.tsx:135`) read that
instead of `displayCoverage`; `displayCoverage` stays on the view as the un-ratcheted truth for
everything else.

### 4.3 The ratchet may not say 100%

```
pct = computed >= 100 ? 100 : min(max(computed, floor), 99)
```

A floor of 100 can only be reached by genuinely completing a narrower interview and then having it
widened. Sitting at "100% completed" while the interviewer asks four more questions is a worse lie
than any drop, so the ratchet stalls at 99 and the true figure retakes it. One line, one test,
one stated invariant.

### 4.4 Milestones need no change at all

They read the fixed figure (§4.1) and inherit it. Feed them the **un-ratcheted** value: the ledger's
job is "has this respondent genuinely crossed this threshold", and banking a threshold off a
presentation floor would spend a banner on a number the respondent never earned. The banner's own
copy states `coveragePct`, so a fired milestone can still differ from the bar by a point or two
while the ratchet is holding — acceptable, and far smaller than the gap this replaces.

### 4.5 The answer panel

`full_progress` shows per-section "X of N" (`answer-panel.ts`), and a whole section appearing
mid-interview cannot be fixed by any numeric trick — nothing is wrong with the counts. That case is
served by Phase C: the respondent is **told** a section was added, so the panel changing under them
reads as the thing they were just told about. No panel change in this spec.

## 5. Phase B — re-read the conversation when scope widens

### 5.1 What it does

On a widening, take the **newly** in-scope question slots and data slots, run one extraction-shaped
pass over the transcript so far with only those as candidates, and write what it finds as ordinary
opportunistic fills.

### 5.2 Where it runs

`messages/route.ts:1192–1220` already has the two trigger points, in the right order and after
persistence: `maybePlanScope` then `maybeAmendPlan`. The re-read runs after both, using the plan
they produced. It covers both pipelines because both go through this route.

**Started there, awaited after `done`** — the pattern `extractAndPersistConversationalProfile`
already uses a few lines below (`captureExtraction`). This is a multi-second call and the
respondent has just waited for the planner; it must not extend the lock on the composer. The
answers land before the generator returns, so the next status poll shows them.

### 5.3 The guards

| Guard                | Rule                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Once per topic**   | Ledger column `rescannedTopicKeys Json @default("[]")`, same convention as `raisedMilestones` / `raisedContradictions`        |
| **New keys only**    | Candidates = members of topics added by this widening, minus everything already in scope. Empty ⇒ return without a call       |
| **Gap-fill only**    | Skip any question that already has an answer row; skip any data slot that already has a fill                                  |
| **Confidence**       | `OPPORTUNISTIC_CONFIDENCE_CAP` (0.45) free text / `OPPORTUNISTIC_TYPED_CONFIDENCE_CAP` (0.75) typed, `provenance: 'inferred'` |
| **Fidelity**         | Nothing extra needed: `questionSatisfactionFloor` already stops an inferred fill satisfying a `must_ask` question             |
| **Transcript bound** | The **whole** session's turns (the point is to look further back than `RECENT_TURNS_WINDOW`), capped by characters            |
| **Never throws**     | Fail-soft like `maybePlanScope`: a failed re-read leaves the interview exactly as it is today                                 |

Write through the normal `turn-run.ts` upsert so accrual and the refinement guards apply, then run
`reconcileChatDataSlotFills` over the newly answered question slots so the panel shows a comment for
the topic rather than a blank.

### 5.4 Shape — needs sign-off

Split as `contradiction/completion-sweep.ts` is split: a pure target-selection + result-filter
helper under `lib/app/questionnaire/scope/`, and an impure runner at
`app/api/v1/app/questionnaire-sessions/_lib/widening-rescan.ts` that loads, calls and persists.

The open question is **which extractor**. Reusing the existing extraction capability with a narrowed
candidate set is cheapest and proven (the route already narrows it), but its prompt is written for
"the turn that just happened" and would be reading a whole transcript. A dedicated prompt is more
honest about the task — _"these questions were not being asked at the time; has the respondent
already answered any of them?"_ — and can be told to be conservative, which is the right bias when
nobody asked the question. **Recommendation: dedicated prompt, reusing the extractor's schema and
the answer-fit resolver.** Sign-off needed because it is the difference between a small phase and a
medium one.

### 5.5 What it is honest about

`session-export.ts` distinguishes _not asked_ from _not answered_ by scope. A question filled by the
re-read **was** answered — just not in response to being asked — and `provenance: 'inferred'` plus
a confidence below the floor is exactly the existing signal for that. No new field, no new column,
and the session viewer's existing provenance rendering covers it.

## 6. Phase C — what the respondent is told

### 6.1 The copy contract

A briefing instruction, never a fixed sentence — the existing reasoning holds: an acknowledgement in
the interviewer's own voice reads as the same person still listening. Three things it must now
carry:

| Element      | Source                                                             | Rendered as                                                     |
| ------------ | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| **What**     | the topic `label`, author-written and in the instrument's language | natural words, not a quoted label — some labels read like codes |
| **How much** | `depth`: `light` is literally two members, `full` is the topic     | "a couple of quick questions" / "a bit more ground to cover"    |
| **Why**      | the respondent's own words (§6.2)                                  | one clause, grounded in what they actually said                 |

Bound by the plain-English rule: no "topic", "scope", "plan", "depth", "section added", "routed",
"seated". The size claim is true rather than approximate, because `light` really is two items.

### 6.2 The reason, and the one place there must not be one

- **Amendment** — `PlanAmendment.request` is already stored. _"You mentioned you wanted to talk
  about hiring, so let's do that."_ Nothing new is needed, and the current line's blanket "do not
  explain" is what has to go.
- **Planner-seated topics** — the per-topic `rationale` exists but is written for an admin
  (_"Not selected — nothing in the opening pointed at this area."_). Rendering that at a respondent
  is worse than saying nothing. This wants an optional respondent-facing reason from the planner —
  a schema and prompt change, deferred to **C2** (§10).
- **The blind-spot check — never.** Its honest reason is "you did not raise it", and
  `chooseCheckTopic` has an _absence of signal_, not evidence about the respondent. The whole
  three-way naming split in `conditional-topics.md` exists to stop that claim being made on any
  surface. Suppress the reason entirely for `source: 'check'`; announce the topic without one.

### 6.3 Gating

The announcement is gated by `conditionalTopics.announce`. The **amendment acknowledgement is
currently not** (`messages/route.ts:361` maps the briefing line unconditionally). Decide once and
apply to both: an admin who turned announcements off should not be given a mid-run one. Recommend
gating both on `announce`, and saying so in `settings-registry.ts:673`'s help text.

## 7. Phase D — the settings conflict, kept narrow

### 7.1 Why not the obvious rule

A blanket _"Conditional Topics is on and progress milestones are on"_ conflict would fire on the
**default configuration** of a mainstream feature — `conditionalTopics.enabled` is the only thing
the admin opted into; `milestoneBannerEnabled` defaults `true`. And the only honest advice it could
give is "turn off your progress signal", which makes the respondent's experience worse on exactly
the longest interviews. `conditional-topics.md` already makes this argument against itself for
`trigger_without_cues`: a warning whose only honest response is _"I know, and I cannot"_ gets the
whole panel skimmed, which costs the warnings beside it that are actionable.

**Phases A–B remove the defect. Do not warn about a defect that has been fixed.**

### 7.2 The rule that is worth having

One `info`, firing on **variance** rather than on the combination:

| id                                     | Severity | When                                                                                                       |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `conditional-topics-progress-variance` | info     | Conditional Topics on, milestone banners on, and conditional topics hold more than ~40% of question weight |

It says something the admin cannot see from either tab — that this instrument's interviews vary so
much in length that a percentage is a weak signal however it is computed — and its actionable
response is real (narrow the topics, or drop the milestone thresholds to one late one).

Cost: `ConfigConflictInput` gains a conditional-question figure. It has **no optional fields by
design**, so adding one breaks both builders at compile time — which is the mechanism working, not
a problem. The Settings editor cannot compute it from config alone (topics are server-side, on the
Topics tab), so this needs the figure threaded from the version payload the way `questionCount`
already is in `configConflictInputFromConfig(config, questionCount)`.

## 8. Data model — one migration, two columns

```prisma
// model AppQuestionnaireSession
progressFloorPct   Int  @default(0)      // §4.2 — presentation floor, never a measurement
rescannedTopicKeys Json @default("[]")   // §5.3 — one re-read per topic per session
```

**Migration note.** App-tier: generate with `--create-only` and strip the phantom pgvector DDL
before applying, or `migrate dev` spawns a DROP-INDEX migration over the platform's five vector
indexes. Prefer `migrate deploy`, verify the indexes afterwards, and restart `next dev` before
verifying live — a running dev server holds a stale Prisma client.

Both columns default, so every existing session reads correctly with no backfill: a floor of 0
ratchets nothing, an empty ledger re-reads nothing that already happened. That is the read-path
answer, not a backfill.

## 9. Tests

| Area                     | Assertion                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The equivalence gate** | With `conditionalTopics.enabled = false`, `progressQuestions === questions`, the floor stays 0, and no re-read is attempted — extend the existing `turn-context.test.ts` gate |
| `progress.ts` (pure)     | Ratchets up; holds on a drop; releases when the true figure passes it; **never returns 100 from the floor**; returns `undefined` when the floor did not move                  |
| `completion-logic`       | `displayCoverage` uses `progressQuestions`; **every gate figure is byte-identical** when it differs from `questions`                                                          |
| The plan-time scenario   | Integration: opening → plan seats topics → the displayed figure does not decrease across the boundary                                                                         |
| Amendment                | Same, across `applyAmendment`                                                                                                                                                 |
| Milestones               | A threshold crossed only against the pre-plan denominator does **not** fire once §4.1 is in                                                                                   |
| Re-read                  | Never overwrites an existing answer; never exceeds the caps; ledger prevents a second run; a thrown extractor leaves the session unchanged                                    |
| Copy                     | The briefing line for a `source: 'check'` topic contains no reason; no implementation vocabulary in any of the three lines                                                    |
| Leak guard               | `widening-rescan.ts` loads structure for a session, so it needs its allowlist line and a reason in `scope/leak-guard.test.ts`                                                 |

## 10. Phasing

| Phase  | Scope                                                                                                                                | Size                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **A**  | ✅ **Shipped.** `progressQuestions` + `progress.ts` + the `progressFloorPct` column + both orchestrators + the status view + the bar | small–medium — one migration, one pure module   |
| **B**  | The re-read: pure target selection, `widening-rescan.ts`, both trigger points, the ledger column                                     | medium — the real work; §5.4 decides how medium |
| **C1** | Amendment acknowledgement gains name, size and the respondent's own reason; `announce` gating settled                                | small — one function, one prompt paragraph      |
| **C2** | Planner emits a per-topic respondent-facing reason (schema + prompt + carriage)                                                      | small–medium, and optional                      |
| **D**  | `conditional-topics-progress-variance` + threading the figure into `ConfigConflictInput`                                             | small, mechanical, optional                     |

A and B share the migration, so they want to be one branch even though they are two commits. C is
independent of both and could go first if the copy matters more than the number. D is the tail and
should not be done before A and B, because most of what it would warn about will no longer be true.

## 11. Consequences to accept, stated plainly

- **A session that ends before the plan is decided reads low.** Early-finish during the opening on
  an enabled version shows a figure measured against the whole instrument. That is honest — they
  did finish early — and the submit gate is untouched. Worth watching in the first client run.
- **The bar can stall.** After a widening it holds while the true figure catches up. That is the
  trade being made deliberately: a stalled bar reads as "this part is taking a while", a reversing
  one reads as the system taking something back.
- **The re-read costs one model call per widening.** Two per session at most today (plan, one
  amendment); more if mid-interview triggers ship, which is a reason to keep the once-per-topic
  ledger rather than a once-per-widening flag.
- **An answer arriving without its question having been asked is a real change in the record.** It
  is the same class of thing opportunistic fill already does — capped, tentative, and confirmed by
  the interviewer before it counts — but it will be visible in transcripts and worth a line in the
  session viewer's provenance help.

## 12. Risks

| Risk                                                              | Mitigation                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The ratchet is mistaken for a measurement and read by an analytic | Invariant §3.2, the column comment, and `displayCoverage` staying on the view as the un-ratcheted truth        |
| `progressQuestions` is threaded into a **gate** by a later change | Named for its one job, optional-with-fallback, and the "gate figures byte-identical" test in §9                |
| The re-read fills confidently from a passing mention              | The opportunistic caps, gap-fill only, and a conservative dedicated prompt (§5.4)                              |
| The re-read makes the plan-time turn feel slower                  | Started after persistence, awaited after `done` — the `captureExtraction` pattern                              |
| The announcement becomes a system notice                          | It stays a briefing instruction in the interviewer's voice, and the plain-English vocabulary ban is tested     |
| A reason is given for the blind-spot check                        | §6.2, tested — this is the one that would make a claim about the respondent the planner never had evidence for |
