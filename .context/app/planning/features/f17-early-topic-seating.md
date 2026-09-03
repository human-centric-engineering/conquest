---
feature: F17.36
title: Early topic seating — deciding during the opening, not only at the end of it
phase: P17 — Conditional Topics
status: SHIPPED (2026-09-02). All five phases landed and the goal of this spec is delivered; §15 records the decisions taken
owner: TBD
opened: 2026-09-02
revised: 2026-09-02 (hard rules DELETED rather than repaired; per-turn decision cap added; decisions settled and phases 1+2 built); 2026-09-03 (closed out at phase 5; the suspend-and-restore material removed, since the tier was deleted and nothing is pending on it)
docs: .context/app/questionnaire/conditional-topics.md
supersedes-in-part: .context/app/planning/features/f17-mid-interview-triggers.md (§6.2, "no plan exists")
evidence: session CPY3-1C6S (Growth Assessor Lead-Gen, version cmthh70e40009ym5ngmdu8veo)
---

# Early topic seating

The opening exists to find out what is relevant, important and significant. Today it can only report
that finding once, at the very end of itself, and only when every one of its members is covered.
This spec lets a sufficiently-evidenced, sufficiently-confident decision seat a topic while the
opening is still running, and bounds how long a respondent can be held in the opening at all.

Everything here is off by default and inert by construction, in the same sense the feature itself
already is.

## 1. What is true today

Verified against the code and the database, not assumed.

| Behaviour                                                                                         | Where                                        |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Conditional topics are out of scope entirely until a plan exists (`plan: null` is not full scope) | `scope/resolve.ts`, `scope/types.ts`         |
| The opening gate is all-or-nothing: every member of every opening topic                           | `scope/planner.ts:572` `isOpeningComplete`   |
| One caller, no partial threshold, no confidence weighting                                         | `_lib/plan-scope.ts:162`                     |
| No timeout, turn cap or force-close. A blocked opening never plans, ever                          | grep: no other caller                        |
| A respondent request during the opening is dropped silently                                       | `_lib/amend-plan.ts:118` `'no plan yet'`     |
| The plan is written once, guarded on `interviewPlan` still being null                             | `_lib/plan-scope.ts`                         |
| Ask order is theme-then-ordinal, topic-local. Scope does not drive it                             | `orchestrator/data-slot-orchestrator.ts:170` |

**The evidence.** Session CPY3-1C6S sat at `interviewPlan = null` after five turns with three of four
opening data slots filled and four of five opening questions answered. The two outstanding members
were `diagnostic_routing` (a data slot whose own description says it records _the interviewer's
routing decision_) and `opening_handoff` (a question slot holding the scripted handoff line, which
contains no question). Neither can ever be covered by a respondent, so the gate could never pass. The
instrument was badly structured, but the product's response to that was to stall in silence, which is
the defect this spec addresses.

**An asymmetry worth knowing.** A data slot self-heals: after `maxDataSlotAttempts` the orchestrator
parks it with a synthesised `provisional` fill, and `provisional` counts as filled in the gate. A
question slot has no equivalent. So the slot half of the gate degrades gracefully and the question
half does not.

**The hard-rules census** (dev database, 2026-09-02): 23 configs carry a `conditionalTopics` block, 3
have the feature enabled, and **exactly one carries a hard rule**. That rule is
`g02-ai-needs-outcome`, an `exclude` on `not_exists`, on Merlin5 Growth Assessor, which is in `draft`
with zero real respondent sessions. It is the worked example from the documentation, not fielded
configuration. This number is what makes §5 cheap.

## 2. The design in one line

> **Planning becomes two stages over one plan: provisional seating during the opening, then the
> existing three-tier planner at the end, which seals the record.**

The final planner still runs, always, over the complete opening. Early seating front-runs it; it never
replaces it. That is what preserves the balanced judgement the current design is built around while
removing the all-or-nothing wait.

## 3. Invariants

Load-bearing. These are the line between a tuning knob and a re-planning engine.

1. **Only ever adds.** An early seat brings a topic into scope. Nothing removes one, including the
   final planner. Same invariant as `scope/amendment.ts` and for the same reason: an interview that
   silently narrowed produces a report that means something different from every other in the cohort.
2. **The final plan is still a single coherent statement.** It absorbs every early seat with its own
   source and turn, so a finished report is still reproducible from the record.
3. **Breadth is one budget.** Early seats consume `maxConditionalTopics`. The two sub-caps in §7 bound
   how much of it partial information may spend, and how much any single turn may spend.

## 4. Readiness — how much of the opening is in

One function, two call sites, one flag, so the gate and the readiness meter can never drift apart.
(The `isOpeningComplete` docblock records what a second definition already cost once.)

```ts
// lib/app/questionnaire/scope/readiness.ts (pure)
export interface OpeningReadiness {
  covered: number;
  total: number; // resolvable members only; unresolvable keys skipped as everywhere else
  ratio: number; // covered / total, 1 when there are no opening topics
  uncovered: { dataSlotKeys: string[]; questionKeys: string[] };
}

export function openingReadiness(
  topics: readonly Topic[],
  filled: ReadonlySet<string>,
  questions: OpeningQuestionCoverage,
  opts: { countParked: boolean }
): OpeningReadiness;
```

- **`countParked: true`** reproduces today's gate semantics exactly (`direct` OR confidence at or
  above `DATA_SLOT_FILLED_THRESHOLD` OR `provisional`). `isOpeningComplete` becomes `ratio === 1`
  under this flag and keeps its current signature as a thin wrapper, so no caller changes.
- **`countParked: false`** is what the early-seating floor reads. A parked slot is a best-effort
  inference the interviewer gave up on, and letting three of those carry a session over the floor
  would mean seating topics on evidence nobody actually gave.

**Two numbers, not one blended score.** The floor is _coverage_ (how much of the opening is in); the
seat is _confidence_ (how sure the planner is about this one topic). They answer different questions,
they are separately explicable on the admin surface, and blending them produces a number nobody can
reason about.

## 5. Hard rules are gone — DONE

**Decision taken and shipped on 2026-09-02: the hard-rules tier was deleted outright.**

This section is kept as the record of why. See
[`conditional-topics.md`](../../app/questionnaire/conditional-topics.md) for what went with it.

The point of Conditional Topics is to choose the right areas semantically, from what the respondent
actually said. Hard rules are a deterministic tier bolted in front of that judgement, and they are
the sole reason the opening gate has to be all-or-nothing: `not_exists` matches on absence, so
evaluating rules over an incomplete opening fires every veto an author wrote, for every respondent,
in a plan that looks entirely reasonable.

Deleting the tier removed that hazard outright and cost nothing measurable: one rule existed, on a
draft questionnaire, with no real sessions (§1). The tiers collapse to two, judgement then
guardrails, and the cap applies purely to the model's picks.

### What is genuinely lost

An author loses the ability to express certainty. Everything becomes judgement, including the cases
the old documentation argued were the most valuable ("never score them on AI readiness when they
never named an outcome"). Such a constraint can now only be written as prose criteria, which is a
weaker thing: a constraint obeyed most of the time. That is an acceptable trade at one draft rule
and zero fielded sessions, and it is the cost to weigh if a client ever asks for a veto.

## 6. Force-closing the opening

`maxOpeningTurns` (default `0`, off). Once the session has taken that many turns and the opening is
still incomplete, it is declared closed and the final planner runs on what there is.

- It covers the question half of the gate, which has no parking equivalent (§1).
- It is what stops a badly-structured instrument stalling in silence.
- With the tier gone it needs no prerequisite work. Evaluating rules over an incomplete opening was
  what made this expensive; deleting them makes it cheap.
- The plan records `forcedClose: true` and the uncovered members, so the session viewer and routing
  analytics can tell a forced plan from a considered one, and an admin gets told the instrument has a
  problem.

## 7. Configuration

Eight new fields on `ConditionalTopicsSettings`. **Every default reproduces today's behaviour
exactly**, so no existing version changes. Suspension (§5) is a constant, not one of these.

| Field                        | Type      | Default | What it does                                                                                               |
| ---------------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `earlyTopicSeating`          | `boolean` | `false` | Master switch. Off, none of the code below is reachable and no query is made.                              |
| `earlySeatingFloor`          | `0–1`     | `0.6`   | Opening coverage (parks excluded) below which nothing is evaluated.                                        |
| `earlySeatingMinConfidence`  | `0–1`     | `0.85`  | Per-topic confidence needed to seat early. Must be at or above `minConfidence`; validate enforces it.      |
| `maxEarlySeatedTopics`       | `int`     | `1`     | Session sub-cap. Counts against `maxConditionalTopics`, never in addition to it.                           |
| `maxRoutingDecisionsPerTurn` | `int`     | `1`     | **New.** How many areas one turn may seat, when a single turn throws up several significant things.        |
| `earlySeatingCadence`        | `int`     | `1`     | Evaluate every N turns once above the floor. `1` is every turn; raise it to trade responsiveness for cost. |
| `announceEarlySeating`       | `boolean` | `true`  | Whether the respondent is told at seat time, or only at the final handover.                                |
| `maxOpeningTurns`            | `int`     | `0`     | Force-close (§6). `0` is off.                                                                              |

### The cap hierarchy

Three caps, and the precedence must be explicit or they will be read as alternatives:

```
maxRoutingDecisionsPerTurn  ≤  maxEarlySeatedTopics  ≤  maxConditionalTopics
   (one turn)                    (whole opening)          (whole interview)
```

`validate.ts` raises a warning when an inner cap exceeds an outer one, because the configuration is
then expressing an intent the runtime cannot honour.

**The per-turn cap governs early seating only.** The final planner seats everything it decides in one
write, because that is the sealed decision rather than a routing reaction to a turn.

### Carriage is not optional

`SETTING_DESCRIPTORS` is declared `satisfies Record<keyof ConditionalTopicsSettings, ...>`, so each
field fails to compile until it has a descriptor in `lib/app/questionnaire/settings-registry.ts`. Each
also needs a `<FieldHelp>` popover per the repo rule, and each appears in the Questionnaire Pack's
Conditional topics section. That guard exists because the pack once covered four of fifteen settings,
silently.

**Labels are plain English**, per the house rule against implementation vocabulary on screen: "Start
choosing areas before the opening finishes", "How much of the opening must be answered first", "How
sure the interview must be to choose early", "Most areas that may be chosen early", "Most areas that
may be chosen from a single answer", "How often to reconsider", "Tell the respondent when an area is
added early", "Longest the opening may run".

## 8. Runtime

### 8.1 The gate, cheapest first

The house shape, from `amend-plan.ts`. Nearly every turn stops at tier 1 having paid nothing.

| Tier | Cost              | What it does                                                                                                              |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0    | one field read    | **Deferred picks outstanding?** Seat up to the per-turn cap from them and stop. No model call.                            |
| 1    | arithmetic only   | Feature on? Above the floor? Cadence due? Session sub-cap unspent? **Did the evidence change since the last pass?**       |
| 2    | one narrowed read | Load topics and existing seats. Eligible candidates remain?                                                               |
| 3    | one planner call  | Judge the eligible candidates over the opening so far. Seat those at or above the confidence bar, up to the per-turn cap. |

**The evidence-change check is the important one.** A turn that added no new fill and no new answer
cannot change the judgement, so it must not pay for one. That single condition removes most turns
regardless of cadence, and it is free to compute from what the trigger already loads.

**Tier 0 exists because of the per-turn cap.** A turn that warrants three seats under a cap of one
would otherwise strand the other two: the evidence would not change on the next turn, so the gate
would block and they would never be seated. Instead the pass records what it judged and could not
seat, and subsequent turns drain that list at the cap rate with no further model calls. It is cheaper
than re-judging and it makes the cap a pacing control rather than a silent truncation.

Deferred picks are cleared whenever a fresh pass runs, so a stale judgement can never outlive the
evidence that produced it. Seating from the list is safe because seating only ever adds (§3.1): the
judgement was made on a subset of the current evidence and cleared the confidence bar at the time.

**No silent truncation.** When a pass judges more topics as warranted than any cap allows, that fact
is recorded on the session and surfaced to the admin. A cap that quietly discards decisions reads as
"the planner only found one area" when it found four.

### 8.2 Where it runs

A new trigger `_lib/seat-early-topics.ts` beside the existing three, called from the post-turn block
in `app/api/v1/app/questionnaire-sessions/[id]/messages/route.ts`, ordered:

```
maybeSeatEarlyTopics  →  maybePlanScope  →  maybeAmendPlan  →  widening rescan
```

Early seating skips entirely when the opening completed on this turn, so a session never both seats
early and seals in the same turn. Never throws; every failure leaves the session exactly as it was,
which is the same outcome as the feature being off.

### 8.3 Where a provisional seat lives — the one real schema decision

`resolveScope` keys off `plan.topics`, and `maybePlanScope`'s "already planned" guard keys off
`interviewPlan` being non-null. Writing a partial plan into `interviewPlan` would therefore make the
session look sealed and the final planner would never run.

**Recommendation: a separate nullable column.**

```prisma
/// F17.36. Conditional topics seated DURING the opening, before the plan was sealed, plus any
/// picks judged but deferred by the per-turn cap. Null on every session that never seated one
/// early, which is nearly all of them. Absorbed into `interviewPlan` when the final planner
/// runs; kept afterwards as the record of when each was seated and on what evidence.
earlySeatedTopics Json?
```

`resolveScope` unions it with `plan.topics`. `interviewPlan` keeps meaning exactly what it means
today, the once-only write guard stays intact in all three places that depend on it, and a sealed plan
stays a single coherent statement.

The alternative, an unsealed plan blob with a `sealed: false` flag, was rejected: every reader of
`InterviewPlan` would have to learn about a second state, and the guard it weakens is load-bearing.

At seal time the early seats are handed to `planScope` as pre-seated keys and seated in
`applyGuardrails` **before the cap**, for the same reason rule-includes used to be: something already
asked cannot be truncated by a later enthusiasm.

### 8.4 New decision source

`SCOPE_DECISION_SOURCES` gains `'early'`, with a label, so the plan, the session viewer and the
routing analytics can all tell an early seat from a planner pick.

### 8.5 Rescan comes free

`widening-rescan.ts` already re-reads the transcript when scope widens, driven by the
`rescannedTopicKeys` ledger, and its docblock states it serves both existing triggers without either
knowing about the other. Early seating is a third widening and inherits it. This needs a test, not
code.

## 9. The respondent-facing half — and the honest problem in it

**This is the part that delivers what was actually asked for, and it is the riskiest.**

Seating a topic changes what is _in scope_. It does not change what is _asked next_. The data-slot
orchestrator picks theme-then-ordinal and stays topic-local, and the opening's themes sort first, so a
newly seated topic waits its turn behind every remaining opening slot. Early seating on its own is
therefore invisible to the respondent, which defeats the point.

Three levers, in increasing order of risk:

1. **Bound the opening** (`maxOpeningTurns`, §6). Cheap, safe, already justified on its own.
2. **Let parking do its work.** A slot the interviewer has given up on stops being re-asked. This
   already happens; what is missing is that a parked opening slot still holds the _gate_ closed under
   `countParked: false`. Resolution: the gate keeps counting parks (unchanged), the floor does not.
   Both are already in §4.
3. **Bridge to a seated topic while opening slots remain.** The orchestrator already has the
   mechanism: `parkedTheme` / `avoidTheme` makes it prefer a slot in a _different_ theme after
   parking, explicitly for forward movement. Extending that to "bridge to a newly seated topic once
   the floor is passed" is the change a respondent would actually feel.

Lever 3 is a change to the orchestrator's pick, not to scope, and it is where the risk concentrates: it
can make an interview feel like it abandoned a line of questioning. Recommendation is to ship 1 and 2
first, measure whether the opening still drags, and treat 3 as its own phase with its own sign-off.

## 10. What the respondent hears

`announceEarlySeating` defaults on, but an announcement per seat would be a drip of "I'll also cover X"
through the opening. Two constraints:

- **Coalesce.** At most one seating announcement per turn, covering everything that turn seated, which
  is also what makes `maxRoutingDecisionsPerTurn` above 1 read naturally: "I'd like to go deeper on A
  and B" is one sentence. The existing `atTurn` matching on the one-turn briefing seam already gives
  exactly-once delivery.
- **Say the same three things an amendment acknowledgement says** (F17.33): what, how much, and why,
  in the interviewer's own voice, with the vocabulary ban intact. An area appearing mid-conversation
  with no explanation is the moment a respondent starts wondering what else is being decided about
  them.

Note this differs deliberately from document triggers, which F17.31 §8 makes silent. That reasoning
was drawn from safeguarding instruments where announcing the topic is harmful. An early seat on a
commercial diagnostic is the opposite case: naming it is the proof the interview listened. Hence a
setting rather than a constant.

## 11. Analytics

`analytics/routing.ts` must count `early` separately and never fold it into `llm`. An early seat the
final planner would also have chosen is a planner success; one it would not have chosen is not, and
counting them together would make the planner look better the more aggressively the floor was tuned.
The same rule `amendments` already follows, for the same reason.

## 12. Validation

New checks in `scope/validate.ts`:

- `opening_member_uncoverable` — an opening topic member no respondent can ever cover. The CPY3-1C6S
  case, caught at authoring time instead of as a silently unplanned interview. Heuristics: a question
  slot whose prompt contains no question, a data slot whose description describes the interview's own
  behaviour rather than a respondent fact. Advisory warnings, not blockers.
- `early_confidence_below_floor` — `earlySeatingMinConfidence` below `minConfidence`, which would make
  early seating less careful than the final planner.
- `cap_hierarchy_inverted` — an inner cap exceeds an outer one (§7).
- `early_seating_without_conditional_topics` — the switch on with nothing it could ever seat.

## 13. Amendment to F17.31

F17.31 §6.2 tier 2 skips when no plan exists, so document triggers cannot fire during the opening
either. Once `earlySeatedTopics` exists there is somewhere for a mid-opening firing to land, and that
restriction should be lifted in the same phase that builds F17.31(b). Recorded here so the two specs do
not drift; nothing in this spec depends on F17.31 shipping.

## 14. Phasing

| Phase | Scope                                                                                                            | Ships behaviour?                 |
| ----- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **1** | ~~§5 hard rules~~ (deleted) + §6 `maxOpeningTurns` + §12 `opening_member_uncoverable` — **SHIPPED**              | Yes: fixes the stall class       |
| **2** | §4 readiness module, `isOpeningComplete` rewired as a wrapper — **SHIPPED**                                      | No: pure, no behaviour change    |
| **3** | ~~§7 settings + §8 column, pure module, trigger, `'early'` source, cap hierarchy, deferred picks~~ — **SHIPPED** | Yes, behind a default-off switch |
| **4** | ~~§9 lever 3: orchestrator bridge to a seated topic~~ — **SHIPPED**                                              | Yes, own sign-off                |
| **5** | ~~§10 announcement, §11 analytics, session viewer, pack, `<FieldHelp>`~~ — **SHIPPED**                           | Surfaces                         |

**Migration note.** Phase 3 adds one nullable column to an app-tier table: generate with
`--create-only` and strip the phantom pgvector DDL before applying, or `migrate dev` will spawn a
DROP-INDEX migration over the platform's five vector indexes. Verify the indexes afterwards.

## 15. Decisions — settled 2026-09-02

All six were taken as recommended.

1. **§8.3** — a **separate nullable `earlySeatedTopics` column**. `interviewPlan` keeps meaning
   exactly what it means today and the once-only write guard stays intact in all three places that
   depend on it.
2. **§4** — readiness **excludes parked fills** for the floor and keeps counting them for the gate.
   Shipped in phase 2: `openingReadiness(…, { countParked })`, one function, both readers.
3. **§9** — **lever 3 is deferred.** Ship phases 1–3, measure whether the opening still drags, then
   decide. Phase 4 keeps its own sign-off.
4. **§10** — **announce at seat time**, coalesced to at most one announcement per turn.
5. **§7** — `earlySeatingCadence` becomes a **module constant, not a setting**, for v1. The
   evidence-change gate in §8.1 does most of what it was for, and seven settings on one tab is
   already at the edge of readable. That leaves six new fields in phase 3.
6. **§7** — **no escalating confidence bar** for the second and subsequent seats within a turn. The
   per-turn cap is the control; a second, subtler control governing the same thing is one an admin
   cannot reason about, and it can be added later if multi-seat turns prove noisy.

### What phases 1 and 2 actually shipped

- `lib/app/questionnaire/scope/readiness.ts` — `openingReadiness`, pure, with the parked-fill flag.
  `isOpeningComplete` is now a thin wrapper over it and keeps its signature, so no caller changed.
- `maxOpeningTurns` on `ConditionalTopicsSettings` (default `0` = off), carried through the Zod
  patch schema, the settings registry, the Questionnaire Pack, and the Conditional topics card's
  step 1 with a `<FieldHelp>`.
- `InterviewPlan.forcedClose` (`{ atTurn, limitTurns, uncovered }`), written by `plan-scope.ts`,
  recorded on the `AppAiRun` detail, logged at `warn`, and rendered at the top of the session
  viewer's plan panel.
- `opening_member_uncoverable` in `scope/validate.ts`, fed by a new optional `memberText` input the
  Topics route supplies. Advisory warning; two conservative heuristics, both documented at the
  call site.

### What phase 3 shipped

- **Schema.** `AppQuestionnaireSession.earlySeatedTopics Json?`, migration
  `20260902211549_app_early_seated_topics`. Generated `--create-only`, the five phantom pgvector
  `DROP INDEX` statements and the `searchVector` `DROP DEFAULT` stripped by hand, applied via
  `migrate deploy`, all five vector indexes verified present afterwards.
- **Five settings** (not six — see §15.5): `earlyTopicSeating`, `earlySeatingFloor`,
  `earlySeatingMinConfidence`, `maxEarlySeatedTopics`, `maxRoutingDecisionsPerTurn`. Every default
  reproduces today's behaviour. Carried through the Zod patch schema, `SETTING_DESCRIPTORS`, the
  Questionnaire Pack, and a new step 3 on the Conditional topics card with a `<FieldHelp>` on each.
- **`scope/early-seating.ts`** — pure: the tiered gate, the evidence fingerprint, candidate
  eligibility, `applyEarlyJudgements` and `drainDeferred`.
- **`scope/early-planner.ts`** — the one model call, mirroring `planner.ts`'s failure discipline
  exactly. Its prompt is the part that differs: the opening is unfinished, silence is the correct
  answer most of the time, and it cannot decline anything.
- **`scope/planner-prompt.ts`** — `renderConveyed` / `renderCandidates` / `ScopeAnswer` extracted
  from `planner.ts` so both passes read the conversation through one rendering.
- **`_lib/seat-early-topics.ts`** — the trigger, first of the four in the post-turn block.
- **`'early'`** added to `SCOPE_DECISION_SOURCES`, counted separately in `analytics/routing.ts` and
  never folded into `llm`.
- **`resolveScope`** unions `earlySeated.seated` with the plan; `applyGuardrails` gained `preSeated`
  and seats it before the cap; `plan-scope.ts` hands the seats over at seal time and records
  `preSeatedKeys` on the audit row.
- **Three validation checks**: `early_confidence_below_floor`, `cap_hierarchy_inverted`,
  `early_seating_without_conditional_topics`. All advisory.

**One interaction decided during the build, not in this spec:** an early seat **suppresses the
fallback**. The fallback's precondition is "no signal to judge on at all", and a topic seated during
the opening is a judgement made on real evidence at a higher bar than the plan itself needed. Padding
it with safe defaults would widen an interview that already knows what it is about. Recorded at the
call site and asserted in `guardrails.test.ts`.

### What phase 4 shipped

§9 lever 3, and the sign-off it required was about **how aggressive** the bridge is, not merely
whether to build it. Three options were on the table; the middle one was taken:

| Option                      | Verdict                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only when a slot is parked  | Safest, and literally what §9's sentence describes — but parking needs `maxDataSlotAttempts` exhausted, so on many instruments it would almost never fire |
| **At any theme transition** | **Chosen.** Never interrupts a theme; changes only which area comes next when one was changing anyway                                                     |
| Immediately after seating   | Most responsive, but interrupts mid-flow and reads as a non-sequitur until the phase 5 announcement                                                       |

- `bridgeToSeatedTopics` (default `true`, inert unless `earlyTopicSeating` is on) — the sixth
  setting, and the escape hatch for the risk the feature carries rather than a second switch for it.
- `pickNextDataSlot` gained a `BridgeIntent`. The topic-local rule is checked **first and unchanged**;
  the bridge acts only where the pick was already moving to a new theme, and at the parked-slot
  transition. Once the visit is spent the preference **inverts**, which is what stops the topic-local
  rule holding the interview in the bridged theme until the whole area is done.
- `MAX_BRIDGED_SLOTS_BEFORE_PLAN = 2`, a module constant. `remaining` is derived from how many seated
  slots are already covered, so there is no counter to keep in sync.
- `TurnState.bridgeDataSlotKeys`, computed in `turn-context.ts` only while the plan is null.

**Not bridged, and deliberately:** question slots. The orchestrator's pick is over data slots; a
seated topic's questions come into scope with it and are answered like any other in-scope question.

**Deferred to phase 5 with the announcement it governs:** `announceEarlySeating`. Shipping the
setting now would put a switch on the tab that does nothing, which is the exact failure this codebase
has already shipped once. It is also coherent to defer: until phase 4 an early seat does not change
what is asked next, so there is nothing to announce.

### What phase 5 shipped

The surfaces, and one design decision the spec left open by not stating it: **who says what, and
when**.

- **`announceEarlySeating`** (default `true`, inert unless `earlyTopicSeating` is on), the sixth and
  last setting. Held back from phase 3 deliberately: until phase 4 an early seat did not change what
  was asked next, so there was nothing to announce, and shipping the switch then would have put a
  control on the tab that did nothing. It sits in step 6 ("What the respondent is told") beside
  `announce`, rendered only while early seating is on, with a `<FieldHelp>` saying why the two are
  separate.
- **`earlySeatingBriefingLine`** in `scope/early-seating.ts`, pure. Says the same three things
  `amendmentBriefingLine` says (§10, F17.33): the area's label, `topicSizeWording` over
  `plannedMembers` at the seat's depth, and the early planner's own `respondentReason`. Coalesced to
  one instruction per turn however many areas that turn seated, which is what makes
  `maxRoutingDecisionsPerTurn` above 1 read as a sentence a person would say. Returns `null` when
  there is nothing to announce, so no caller checks emptiness twice.
- **The one-outing match** is `seat.atTurn === selectionRound`, the mechanic the handover and the
  amendment acknowledgement already use. `drainDeferred` re-stamps a deferred pick with the turn it
  was finally taken, so an area announces itself when it came into scope, not when it was judged.
- **Silent once a plan exists.** Not in the spec, and decided during the build. A turn can both seat
  and seal; the plan absorbs every early seat and its handover is the statement of what the interview
  covers, so announcing the seat as well would tell the respondent about the same area twice in one
  message. The gate is `scopePlan === null`, which also makes the notice unreachable for the whole
  rest of the interview.
- **§11 analytics on the surface.** `bySource.early` was already counted in phase 3 and rendered
  nowhere. The routing-quality card gains a **Chosen early** column, beside `Sampled` and for the
  same reason, plus `earlySeatedPlans` on the result and in the footer: the per-topic rows say which
  areas, the plan count says how often an opening decided anything at all before it finished.
- **The session viewer** gains `AdminEarlySeatingView` and `EarlySeatingCard`. It answers what the
  plan panel cannot in two cases: an interview that never reached a plan, where the viewer would
  otherwise read as "no decision was made", and one whose plan flattened the timing under a single
  `decidedAtTurn`. It also keeps what the respondent was **told** beside the reason the admin was
  given, and the areas the caps judged warranted and never took.
- **The Pack** carries the setting through `settings-registry.ts`, printed only while early seating
  is on. Same rule as `bridgeToSeatedTopics`: a row saying "No" beside a feature nobody enabled reads
  as a silence the author chose.

## 16. Risks

| Risk                                                                    | Mitigation                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Early seat on thin evidence produces a worse interview than waiting     | Floor excludes parks; confidence bar defaults above `minConfidence`; both sub-caps default to 1. |
| Cost of per-turn evaluation during the opening                          | Evidence-change gate removes most turns before any call; tier 0 drains deferred picks free.      |
| `maxRoutingDecisionsPerTurn` silently truncates a good multi-topic read | Deferred picks (§8.1 tier 0) drain rather than discard, and over-cap passes are recorded.        |
| It becomes a general re-planning engine by increments                   | §3 is the line. Any request to remove, re-rank or re-plan is a different spec.                   |
| Lever 3 makes interviews feel scattered                                 | Own phase, own sign-off, measured against the current arc before default-on.                     |
