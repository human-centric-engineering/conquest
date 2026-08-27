---
feature: F17.31
title: Mid-interview triggers — "add this block whenever it surfaces"
phase: P17 — Conditional Topics
status: phase (a) shipped as F17.31a (2026-08-26); phases (b)–(d) proposed, need sign-off on §3 and §14
owner: TBD
opened: 2026-08-26
docs: .context/app/questionnaire/conditional-topics.md
evidence: tests/fixtures/app/questionnaire/routing-corpus/RESULTS.md (R010, R011, R012)
---

# Mid-interview triggers

A questionnaire that says _"if the applicant discloses abuse **at any stage** — including in
passing while answering something else — add this block"_ cannot be configured today. Conditional
Topics settles scope once, when the opening completes, so a disclosure in minute 40 adds nothing.

This spec adds one mechanism: **a topic the instrument attaches to a condition on the running
conversation, rather than to the opening.**

## 1. Why, with numbers

Three of the ten routing-corpus documents specify this, and the pipeline fails all three the same
way. From the ledger:

| Doc | What it says                                                                     | What happens today                                 |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| 07  | five triggered blocks, "at any stage", incl. abuse, care-leaver, immigration     | all five become opening-time criteria + a gap each |
| 08  | estate planning "only ever asked where the client raises inheritance themselves" | rendered as an opening-time criterion              |
| 10  | four escalation blocks, "whenever they surface, at any point in the review"      | all four become opening-time criteria + a gap each |

R012 (doc 07, `f99a07c1e`) is the current state: the analyst now **declares** every one of these
in `gaps[]`, in its own words — _"the platform cannot add a topic after the opening has finished"_ —
and then proposes them as conditional topics anyway, because a block belonging to no topic has
unaskable questions (`validate.ts` → `orphaned_questions`). The silence was fixed in the post-R010
prompt work. The coercion cannot be: it is a missing mechanism, and this is that mechanism.

## 2. The one-line architecture

> **A trigger is a hard rule whose input is the transcript instead of the opening's data slots.**

That framing decides most of the open questions, and it is worth holding onto:

- Hard rules (`scope/rules.ts`) are for what the author is **certain** about; the planner is for
  judgement. A document saying "add this block when X comes up" is certainty, not judgement — so a
  trigger firing is not a planner decision and must never be counted as one.
- Hard rules are resolved **before** the model and are never overridden by it. A trigger likewise
  outranks `maxConditionalTopics` — see §7.
- Hard rules only assert; they never negotiate. A trigger only ever **adds** — §3.

## 3. What this is NOT — the invariants that keep it safe

These are load-bearing. Breaking any one of them turns a scoped feature into a re-planning engine.

1. **Only ever adds.** A trigger can bring a topic into scope. Nothing can take one out mid-run.
   This is the same invariant `scope/amendment.ts` states and for the same reason: a respondent
   whose interview silently narrowed would produce a report that means something different from
   every other report in the cohort.
2. **The plan is never recomputed.** No re-planning, no re-ranking, no second `planScope` call. A
   firing appends one topic and one record. The plan blob stays the single coherent statement of
   what this interview covered, which is what makes a finished report reproducible from the record.
3. **One firing per topic per session.** A trigger is a latch, not a subscription.
4. **A trigger never removes the gap for what is still inexpressible.** Doc 10's mutual exclusivity
   ("a partner takes one of these, not several") and its terminating screener are _different_
   missing mechanisms — see §12. Shipping triggers must not let the analyst stop declaring those.

## 4. Data model

One nullable JSON column, on the topic that the trigger adds.

```prisma
// prisma/schema/app-questionnaire.prisma — model AppQuestionnaireTopic
/// F17.31. Present only on a topic the INSTRUMENT says to add when something surfaces mid-
/// interview, rather than one the planner chooses from the opening. Shape:
/// `{ condition: string, cues: string[], sourceQuote?: string }` — see TopicTrigger
/// (scope/types.ts). Null on every topic that predates this and on every topic the author
/// scopes from the opening, which is nearly all of them.
trigger Json?
```

```ts
// lib/app/questionnaire/scope/types.ts
export interface TopicTrigger {
  /** "The applicant discloses that they are experiencing or fleeing abuse." The judgement text. */
  condition: string;
  /**
   * Literal words or short phrases, taken FROM THE INSTRUMENT, that make the cheap gate possible:
   * "abuse", "fleeing", "domestic". A turn containing none of them never costs a model call.
   *
   * Authored rather than inferred, and that is what makes this work in any language — unlike
   * `AMENDMENT_CUES`, which is a hardcoded English regex list and silently returns false on a
   * non-English version (see `isEnglishLocale`). These cues are written in the instrument's own
   * language by whoever wrote the instrument.
   */
  cues: string[];
  /** The span of the source document that says so. Absent on a hand-authored trigger. */
  sourceQuote?: string;
}
```

**Why a field on the topic rather than a new table.** Every corpus document is 1:1 — one block, one
trigger sentence. A table would buy multi-condition triggers nobody has asked for, at the cost of a
fifth thing to carry through fork, import, export, pack and draft-accept (§10). Alternates are
already expressible: `cues` is a list, and `condition` is prose.

**Phase stays `conditional`.** Adding a `triggered` phase to `TOPIC_PHASES` would touch the planner,
`ALWAYS_PHASES`, `resolveScope`, `budget.ts` and every validate check — a large blast radius for a
distinction one nullable field already draws.

## 5. Analyst contract

`proposedTopicSchema` (`scope/analysis-schema.ts:60`) gains an optional `trigger`, and the two
existing refinements gain one exception each:

```ts
trigger: z.object({
  condition: z.string().trim().min(1).max(TOPIC_CRITERIA_MAX_LENGTH),
  cues: z.array(z.string().trim().min(1).max(TRIGGER_CUE_MAX_LENGTH)).min(1).max(MAX_TRIGGER_CUES),
  sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
}).optional(),
```

- The `conditional` topics must carry criteria refinement becomes **criteria OR trigger**. A
  triggered topic has nothing for the planner to judge at opening time, so requiring `criteria`
  would force exactly the coercion this feature removes.
- `cues` has a `.min(1)`: a trigger with no cues can only be evaluated by paying a model call on
  every turn, which is the design this spec exists to avoid.

`analysis-prompt.ts` changes in one place — the gaps rubric's **timing** exception, added post-R010,
currently tells the analyst to convert the block _and_ gap it. It becomes: put the condition in
`trigger`, not `criteria`; gap only what remains inexpressible (ordering — "complete it before you
close" — mutual exclusivity, termination).

**Do not delete the timing gap wholesale.** Doc 07's blocks say _"add this block immediately and
cover it before returning to whatever you were asking"_. Interrupt-and-cover ordering is still not
expressible after this ships (§12), so that half stays a gap.

## 6. Runtime — where it fires

Two evaluation points, both reusing machinery that exists.

### 6.1 At plan time (free)

`planScope` already has the opening transcript in hand. Evaluate triggers over it before the
planner runs, exactly as `evaluateScopeRules` does — a condition already apparent in the opening is
seated immediately, with `source: 'trigger'`. This alone fixes doc 08's estate-planning case, where
the client raising inheritance early is the common path.

Triggered topics are then removed from `plannerCandidates` (`guardrails.ts:402`) and recorded in
`plan.excluded` with `source: 'trigger'` and the rationale _"waiting for the instrument's trigger"_,
so the plan stays a complete statement of every conditional topic and why it is where it is.

### 6.2 Per turn — `maybeFireTriggers`

A new module beside `amend-plan.ts`, called from the same post-turn block in
`app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts:1206`, immediately after
`maybeAmendPlan`. Never throws; every failure leaves the plan as it was.

Three tiers, cheapest first — the shape `amend-plan.ts` proved:

| Tier | Cost                 | What it does                                                                                                                    |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1    | one string scan      | Does the turn contain any cue of any un-fired trigger? Nearly every turn stops here, having paid nothing.                       |
| 2    | one narrowed read    | Load the plan + the version's triggered topics. Skip if the feature is off, no plan exists, or every trigger has already fired. |
| 3    | one small model call | "Does this turn indicate _{condition}_? Answer yes/no." Judgement, only for a turn that already hit a cue.                      |

Tier 3 is a confirmation step, not a search: a cue hit alone must not seat a topic. _"We had a food
safety audit years ago and it was spotless"_ contains the cue and is not the condition. This is the
same failure `amendment.ts` guards against when it insists on an asking verb — _"risks widening an
interview because someone mentioned a subject in passing"_ — inverted, because here mentioning it
in passing IS the instruction, and the model call is what separates a mention from a disclosure.

On a yes: `applyTrigger` (pure, in `scope/triggers.ts`, modelled on `applyAmendment`) appends the
topic at `full` depth with `source: 'trigger'`, removes it from `excluded`, appends a
`TriggerFiring` to `plan.triggered[]`, and writes the blob back with the same guarded `updateMany`
`amend-plan.ts` uses. `resolveScope` reads `plan.topics`, so the added block's questions are in
scope on the very next turn with no further wiring.

### 6.3 Plan record

```ts
export interface TriggerFiring {
  key: string;
  label: string; // at firing time, so the record reads after a rename
  condition: string; // what fired, not just that something did
  cue: string; // the cue that opened the gate — cheap to audit
  atTurn: number;
  at: string; // ISO
}
```

`InterviewPlan` gains `triggered?: TriggerFiring[]`, absent on every plan that predates this —
the same optionality `amendments?` uses, for the same read-path reason.

**Deliberately not stored: the respondent's words.** `PlanAmendment.request` stores them because
the respondent's own request is the evidence for an amendment. Here the evidence is the condition
and the cue, and a triggered block is disproportionately likely to be the most sensitive turn in the
transcript — abuse disclosure, immigration status, a grievance. The transcript already holds it
once, under the session's retention and erasure rules; the plan blob does not need a second copy.

## 7. Caps, budget and the settings

`ConditionalTopicsSettings` (`scope/types.ts:463`) gains two fields:

| Field                            | Default | Why                                                                                                                                                                                           |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowDocumentTriggers: boolean` | `true`  | Inert unless a topic carries a `trigger`, which only the analyst or an admin can create — so a `true` default changes no existing version's behaviour, and the off-is-silent invariant holds. |
| `maxTriggeredTopics: number`     | `3`     | A separate ceiling. A pathological instrument with twelve triggers should not be able to double an interview.                                                                                 |

**Triggers bypass `maxConditionalTopics`.** That cap governs how many areas the _planner_ may
choose; a trigger is authored certainty, and silently dropping one for a breadth limit is the same
class of failure as coercing it. `maxTriggeredTopics` is its own budget and is reported separately.

**Budget: record, never refuse.** `plan.estimatedSeconds` is recomputed additively on each firing
(`topicSeconds` from `scope/budget.ts`) and a `budgetExceededByTrigger: true` flag is set when the
total passes `budgetSeconds`. Refusing a firing to protect a time estimate would discard an
authored instruction to protect a projection — the wrong trade, and invisible to the admin. The
flag is what the Topics tab and the session viewer surface.

## 8. What the respondent hears — silent by default

An amendment is acknowledged (`amendmentBriefingLine`) because the respondent asked for something
and deserves an answer. **A trigger is not.** Nobody asked; the instrument decided. Announcing _"I'll
also ask you about domestic abuse"_ immediately after a disclosure is at best jarring and at worst
harmful, and the interviewer is about to ask those questions anyway.

So: no announcement, no briefing line, no `announceTriggered` setting in v1. If a client wants one,
it is a per-questionnaire House Rule (`interviewer-house-rules.md`), not a scope-engine feature.

**Completion must wait for it.** The added topic's questions are in scope, so the completion logic
(F4.5) will not close while they are unanswered — this is behaviour we get for free from
`resolveScope`, and it is exactly what the documents demand ("complete it before you close"). It
needs a test, not code.

## 9. Analytics — do not let a trigger flatter the planner

`analytics/routing.ts:144` already unions two records of an amendment specifically so a respondent's
correction cannot be counted as the planner succeeding. A trigger needs the same treatment for the
opposite reason: it is not a planner decision at all.

- `source: 'trigger'` topics are excluded from `selected` / `chosen` / `bySource`.
- A new `triggered` counter per topic row, and `triggeredPlans` on the summary.
- `SCOPE_DECISION_SOURCES` (`types.ts:175`) gains `'trigger'`; `SCOPE_DECISION_SOURCE_LABELS` gains
  **"The document said to add this if it came up"** — plain English, per the UI copy rule.

## 10. Carriage — the five places a new topic field must go

A `trigger` that does not survive a fork is worse than no trigger, because it fails silently on the
copy the client actually fields.

| Seam                    | File                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fork a version          | `app/api/v1/app/questionnaires/_lib/copy-version-graph.ts:383`                                                |
| Accept an analyst draft | `app/api/v1/app/questionnaires/_lib/topic-draft.ts:104`                                                       |
| Create/edit a topic     | `app/api/v1/app/questionnaires/_lib/topic-routes.ts:172` (`buildTopicCreateInput`, `TOPIC_SELECT`, `toTopic`) |
| Import a definition     | `app/api/v1/app/questionnaires/_lib/import-definition.ts:315` + `definition-export.ts`                        |
| Questionnaire pack      | `lib/app/questionnaire/export/build-pack-model.ts` (+ csv / markdown builders)                                |

`seed-topics.ts` needs nothing — a seeded topic has no trigger.

## 11. Validation — new checks in `scope/validate.ts`

| Code                                 | Severity  | When                                                                                                                            |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `trigger_on_always_topic`            | error     | A trigger on an `opening` / `core` / `closing` topic. It would never fire — the topic is always asked.                          |
| `trigger_without_cues`               | error     | Empty `cues`. Unevaluable without paying per turn.                                                                              |
| `trigger_cue_absent_from_instrument` | warning   | A cue that appears nowhere in the version's question prompts or the source document. Usually a cue invented rather than quoted. |
| `triggered_topic_also_in_fallback`   | warning   | A triggered topic named in `fallbackTopicKeys`: the safety net would seat what the instrument said to wait for.                 |
| `conditional_without_criteria`       | _amended_ | Now satisfied by criteria **or** a trigger.                                                                                     |

## 12. Explicitly out of scope — the two other missing mechanisms

Do not let these ride along; each is its own decision and each still belongs in `gaps[]` after this
ships.

1. **Termination / ineligibility** (doc 10's screener). `SCOPE_RULE_ACTIONS` is `include | exclude`
   (`types.ts:161`) and `SESSION_STATUSES` has no ineligible state — `aborted` belongs to the abuse
   gate, `abandoned` is manual. My read is that a stop condition is not a Conditional Topics concern
   at all: it is a **pre-interview eligibility gate** that ends a session with a reason and a
   terminal status analytics will not read as a drop-out. Separate spec.
2. **Mutual exclusivity** (doc 10's three role sections). The schema cannot say "exactly one of
   these three". Cheapest correct answer for now is the gaps rubric carve-out already proposed as
   **T14** in the ledger; an `exclusiveGroup` on the topic is a later, bigger conversation because
   the planner's cap arithmetic and `comparability.ts`'s set-cover both assume topics are
   independent.
3. **Interrupt-and-cover ordering.** "Add this block immediately and cover it before returning to
   whatever you were asking" is a sequencing instruction. This spec seats the topic; the interviewer
   still reaches it in its own time. Keep gapping the ordering half.

## 13. Consequences to accept, stated plainly

- **Scope stops being a function of the opening alone.** `scope/amendment.ts`'s docblock defends
  the once-only design — _"a plan that shifted under a running interview would make a finished
  report unreproducible"_ — and respondent amendment already breaches it in the respondent's
  favour. Reproducibility survives because the _record_ is complete: the plan blob says which
  topics were seated, by what, at which turn. What is genuinely lost is the ability to say "this
  respondent's scope follows from their opening", and that is the trade being made deliberately.
- **Cohort comparability gets more variable, not less sound.** `buildCohortDataset` already
  computes scale means only over respondents asked the whole scale and counts the rest as
  `partiallyAssessed` (F17.13), so a triggered topic cannot silently pollute a chart. It does mean
  more respondents land in the partial bucket for scales that draw on triggered topics — worth a
  line in `comparability.ts`'s findings so an author sees it at authoring time, not after fielding.
- **Cost.** One extra small-model call on turns that hit a cue. Corpus-shaped instruments have a
  handful of triggers and cues that are specific nouns; the expected rate is low, but it should be
  measured in the first client run rather than assumed.

## 14. The corpus, and the scoring question this forces

Once triggers are expressible, **the corpus ground truth genuinely changes** — the README says the
triggered blocks belong in `gaps[]` _because the product cannot do them_. When it can, the correct
output for docs 07, 08 and 10 becomes a topic with a trigger, and the critical-failure test for
doc 07 ("any of the five triggered blocks rendered as an opening-time criterion") is satisfiable
for the first time.

That is **T15** in `RESULTS.md`, currently open. It should be settled as part of shipping this and
not before, and the ledger's rule applies: the ground truth moves because the mechanism moved, and
the run that first measures it says so in its "Changed since last run". Expected effect on a run
after this ships — doc 07 `T` 0 → 2 and its critical failure cleared; doc 08 `R` improves; doc 10
unchanged until §12.1 and §12.2 are decided, because its remaining failures are termination and
exclusivity, not timing.

## 15. Phasing

| Phase | Scope                                                                                                                                                                                                                                                                                                              | Rough size                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **a** | ✅ **Shipped — [F17.31a](./f17.31a.md).** Schema + types + analyst contract + prompt + validate checks + carriage. Nothing fires; the Topics tab and the analyst's card show the recorded trigger, read-only. Editing was deliberately deferred: authoring a trigger by hand buys nothing while nothing reads one. | small — one migration, one Zod delta, two prompt paragraphs |
| **b** | `scope/triggers.ts` (pure) + `maybeFireTriggers` + plan-time evaluation + the `'trigger'` decision source.                                                                                                                                                                                                         | medium — the real work                                      |
| **c** | Carriage (§10) + analytics (§9) + session-viewer surfacing of a firing.                                                                                                                                                                                                                                            | medium, mechanical                                          |
| **d** | Corpus re-run of 07, 08, 10 ×2 each, T15 settled, ledger updated.                                                                                                                                                                                                                                                  | one run                                                     |

**Migration note.** One nullable column, but it is an app-tier migration: generate with
`--create-only` and strip the phantom pgvector DDL before applying, or `migrate dev` will spawn a
DROP-INDEX migration over the platform's five vector indexes. Prefer `migrate deploy`, and verify
the indexes afterwards.

## 16. Risks

| Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False firing widens an interview** on a passing mention                                                                                                                                                                                                                                                                                                                                                                                               | Cue gate + model confirmation of the _condition_, not the cue; `maxTriggeredTopics`; one firing per topic.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **A cue that is a whole utterance matches almost nothing** — the residual after the voice fix. `"he hits me"` is in the right register but carries a pronoun and a word order; a respondent saying "my partner hits me" would not match it, and the gate would miss exactly the case it was written for.                                                                                                                                                | Ask for the distinctive **fragment** that survives inside a longer sentence — `"hits me"`, not `"he hits me"`. Cheap prompt refinement, and worth doing before any matcher is built rather than after.                                                                                                                                                                                                                                                                                                                                                                  |
| **Cue lists rot** as an instrument is edited                                                                                                                                                                                                                                                                                                                                                                                                            | `trigger_cue_absent_from_instrument` warning at validate time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Cues come back in the document's voice, not the respondent's** — found on the first live run of doc 07 under F17.31a, and **fixed in the same phase**. The analyst had lifted `"someone they live with"`, `"have lived with"` and `"tenancy block has already been completed"`: faithful to the instrument, and not one of them a phrase a person answering a question would say. A gate built on those would miss the disclosure it exists to catch. | The prompt now sends the instruction's own words to `condition`/`sourceQuote` and asks `cues` for **what the respondent would say**, taught with a deliberately unrelated example so the corpus' own documents are not handed their answers. Re-measured on doc 07 the same day: abuse cues went from `"experiencing abuse", "someone they live with"` to `"he hits me", "I'm scared", "I fled home"`; arrears from `"arrears", "tenancy block has already been completed"` to `"behind on rent", "owe my landlord", "missed rent"`. Same five triggers, same six gaps. |
| A trigger seats a topic **so late** the interview cannot cover it                                                                                                                                                                                                                                                                                                                                                                                       | Budget flag + the completion logic holding the close. Watch it in the first client run; a "too late to seat" cut-off is a v2 decision, not a v1 guess.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The feature becomes **a general re-planning engine** by increments                                                                                                                                                                                                                                                                                                                                                                                      | §3's four invariants are the line. Any request to remove, re-rank or re-plan is a different feature with a different spec.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
