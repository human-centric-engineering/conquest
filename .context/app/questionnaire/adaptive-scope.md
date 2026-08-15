# Adaptive Scope

**Which parts of a questionnaire apply to this respondent, and who decides.**

ConQuest already decides two things: **which question next** (selection strategies) and **which
questionnaire next** (the Experience switcher). Adaptive Scope is the gap between them. Screeners,
eligibility checks, role-specific question sets, compliance sections that must be recorded as
not-applicable, and any long instrument that should not ask all of itself to everyone are all the
same requirement — and before P17 the only way to express it was to split the questionnaire into
several, which costs cross-section scoring and cohort analysis.

> **Status:** F17.1–F17.6 shipped — the model, the runtime, the planner, the authoring
> surface, the Routing Analyst, report/scoring awareness, and respondent amendment. The pilot client
> instrument itself is not built: it needs its source workbook, which is not in this repo.

### The tab is called "Adaptive scope"; the URL segment is still `topics`

The capability is what an admin is looking for in the tab bar, and "Topics" named only the unit it
edits — a noun that collides with the data-slot `theme` and with the orchestration analytics
"topics" page, and that says nothing about conditionality. The label now matches the vocabulary
every other surface already used (the settings card, the launch-checklist item, the session viewer,
this document).

The route stayed `…/v/[vid]/topics`: renaming it would break bookmarks and the launch checklist's
deep link for no behavioural gain. Component and payload names (`TopicsPanel`, `TopicsPayload`,
`getVersionTopicsCached`) follow the route, not the label.

---

## The one invariant

**Off by default, inert by construction.**

`adaptiveScope.enabled` defaults `false`, every auto-seeded topic is `core` (always asked), and
`resolveScope` short-circuits to full scope on either condition. A version that never opts in cannot
reach a single new runtime code path — `buildSessionScope` does not even query the topic table.

That equivalence is a tested gate, not a hope: `turn-context.test.ts` asserts both the unchanged
output and the absent query.

---

## The four concepts

| Concept            | What it is                                                                                                              | Where it lives                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Topic**          | The conditional unit: a named group of question + data-slot **keys**, with a phase, plain-English criteria, and a depth | `AppQuestionnaireTopic`                 |
| **Hard rules**     | A short optional list checked before the agent — the cases the author is certain about                                  | `adaptiveScope.rules` (config Json)     |
| **Scope Planner**  | Runs once, when the opening completes: rules → judgement → guardrails                                                   | `scope/planner.ts`                      |
| **Interview Plan** | The per-session record: which topics, which not, why, and what the respondent was told                                  | `AppQuestionnaireSession.interviewPlan` |

### Size is not significant

A topic may hold thirty questions or one — and **a one-question topic is how a fine-grained
interdependency is expressed** ("only ask about channel conflict if they sell through partners").
That is why there is no second `showIf` expression language: the coarse and fine cases are the same
mechanism at different sizes, so an author learns one thing and we maintain one evaluator.

### Membership is keys, never row ids

`members` holds `{ dataSlotKeys, questionKeys }`. That is what lets a topic survive a version fork
with **no re-linking at all** — `copyVersionGraph` copies topics verbatim and they land on the copied
questions, because those carry their keys over 1:1. It also keeps an `AppAiRun` snapshot legible.

Unresolvable keys are silently skipped everywhere. An author deleting a question a topic still names
must never break a live interview; `validateAdaptiveScope` surfaces it on the authoring surface,
which is where it can actually be fixed.

### Topic ≠ data-slot `theme`

A `theme` is a display grouping (the respondent panel, the orchestrator's topic-local targeting). A
topic is the conditional unit. They usually align — the ingest auto-seed makes them align — but they
are different fields with different jobs.

---

## The phases

| Phase         | Runs                                          | Chosen between?                              |
| ------------- | --------------------------------------------- | -------------------------------------------- |
| `opening`     | First. Its answers are what the planner reads | Never                                        |
| `core`        | Always                                        | Never                                        |
| `conditional` | Only when selected                            | **Yes — the only phase the planner touches** |
| `closing`     | Always, last                                  | Never                                        |

`core` is the default so an auto-seeded topic is always-asked: **seeding is preparation, not
activation.** Uploading a document creates one topic per extracted section and changes nothing about
how the questionnaire runs.

---

## Runtime

### One resolver, one choke point

```
buildTurnContext ──> buildSessionScope ──> resolveScope (pure)
                            │
                            └──> filters questions[], slots[], dataSlots[]
                                     │
                                     ├─ targeting          ─┐
                                     ├─ end-of-run sweep    │  all downstream of the
                                     ├─ coverage/completion │  same three lists
                                     └─ contradiction       ─┘
```

Filtering in `buildTurnContext` rather than in each consumer is what makes scope impossible to apply
inconsistently. Two other loaders apply it themselves because they do not go through the turn path:
`answer-panel.ts` (the respondent must see their interview, not the bank) and `session-export.ts`
(a blank cell must read _not asked_, never _not answered_).

**`byId` stays unscoped on purpose.** A turn taken before the plan narrowed the interview may have
targeted a question now out of scope, and the extractor still needs to know what was asked in order
to read the answer to it. **Scope governs what is asked next, never what was already asked.**

### The leak guard

`tests/unit/lib/app/questionnaire/scope/leak-guard.test.ts` reads the source and fails if a module
that loads a version's structure _for a session_ does not apply scope. Adding a loader means adding
a line to its allowlist with a reason — which is the point. It caught the form write seam on its
first run.

### Before the plan exists

`plan: null` on an enabled version is **not** full scope: it is the pre-planner state, where the
always-run phases are in scope and the conditional ones are not. That is what makes the opening
_decide_ the rest rather than run alongside it.

A **malformed** plan, by contrast, resolves to the always-run phases via `narrowInterviewPlan`
returning null. The direction is deliberate: asking someone a question they did not need is a poor
experience; silently withholding questions the instrument was meant to ask is a wrong result. **When
in doubt, ask.**

---

## The planner

Three tiers, in order — and the order is the design.

1. **Hard rules** (`scope/rules.ts`). Every match applies (not first-match-wins: include and exclude
   are independent assertions about different topics, so stopping at the first would silently drop
   the rest). **Exclude beats include** — an author's "never" is a line drawn, and a second rule they
   forgot must not cross it.

   `not_exists` is the one operator that matches on ABSENCE, and the one exception to "an unfilled
   slot never matches". It exists because the most valuable hard rules are **vetoes** — "never score
   them on AI readiness when they never named an outcome they want it to move" — and a veto is a
   statement about something the respondent did _not_ say. Without it that rule could only be
   written as prose criteria, which is exactly the failure hard rules exist to prevent: a constraint
   obeyed most of the time.

2. **The judgement** (`scope/planner.ts`). One call over the author's criteria and what the
   respondent actually said. Skipped entirely when there is nothing to decide — no conditional
   topics, or **every remaining candidate already force-included by a rule**. Rule-included topics
   stay in the candidate list on purpose (a model proposing in ignorance of half the plan doubles up
   on the same ground), but `applyGuardrails` seats them _before_ the model's picks, so when they are
   all that is left every proposal could only land on a key already seated. Paying a reasoning-model
   call — and up to 12s of a waiting respondent's time — for that is waste.
3. **Guardrails** (`scope/guardrails.ts`). The cap, the blind-spot check, the fallback.

> **The model proposes; it never gets the last word on a hard constraint.** Six numbered rules in a
> system prompt are obeyed _most_ of the time, which is the worst possible failure mode — plausible
> plans that quietly break the limit an author set, with nothing to catch them.

### What the judgement reads

Two things, in this order: **what the respondent said**, and **what was captured from it**.

The words come first because that is what they are — the primary record. A data-slot fill is an
_extraction_ from those same words, so it can be thin, stale, or simply absent; a planner reading
only fills is reading a summary of a conversation it was never shown. The prompt says so, in the
rule that stops the model treating a fill as corroboration of the answer it was derived from.

Fills alone was the original design, and it had a hole an author could fall into without ever being
told: **an opening built from questions with no data slots behind them produces no fills**, so the
prompt read `(nothing was captured in the opening)` and the planner chose sections from nothing.
Reading the answers closes that, and makes the opening work however the author set up the
extraction.

Each answer carries the question it answered — "about two years" is not evidence until you know it
answered "how long has this been a problem?". The **paraphrase** is preferred over the stored value,
because for a typed question the value is the mapped form code (`gt3`), and feeding form codes to a
model reading for meaning is noise. An answer with neither is dropped rather than printed empty.

The block is capped (`MAX_ANSWERS_IN_PLANNER_PROMPT`), and the caller orders the **opening's**
answers first: the plan is a judgement about the opening, and a core topic with forty questions must
not push the answers the decision rests on out of the prompt.

> The `AppAiRun` prompt snapshot therefore now holds the respondent's answers verbatim, where it
> previously held only fill paraphrases. That is the same class of content and the same retention,
> but it is more of it — worth knowing before pointing anything new at those snapshots.

### Guardrail order

```
rule excludes ─> rule includes ─> the cap ─> the fallback ─> the fit ─> the blind-spot check
                      ▲                          ▲              ▲              ▲
        seated BEFORE the cap so a         only when      drops what the   drawn from what
        model's enthusiasm cannot          nothing at     budget cannot     did NOT make
        truncate an author's "always"      all was        pay for, in       the cut
                                           seated         seconds
```

The fit is seated where it is for three reasons. **After the rules**, so an author's "always ask
about compliance" is never costed away — if the rules alone bust the budget the interview runs long
and the settings tab has already said so. **After the fallback**, so a safety net cannot smuggle in
an interview nobody has time for. **Before the check topic**, so the check's own seconds are
_reserved_ rather than treated as free.

### The respondent may add, never remove (F17.6)

`allowRespondentAmendment` honours "actually, ask me about talent" by bringing an excluded
conditional topic into scope at `full` depth. Three tiers again, cheapest first: a regex **cue gate**
(nearly every turn is an answer, not a request, and this rules those out before any query), a
deterministic **label match**, and only then a small **routing-tier model call** to resolve
"can we cover hiring?" against a topic called "People & capability".

**It only ever adds.** A respondent declining a topic the instrument requires is a different feature
with different consequences — partial scoring, an incomparable cohort — and quietly allowing it here
would make every completed assessment mean something slightly different.

The amendment is recorded on the plan (`InterviewPlan.amendments`) _and_ the added topic carries
`source: 'respondent'`. Routing analytics must be able to tell the two apart from a planner success:
**a correction is evidence about the planner, not an example of it working**, and counting an amended
topic as a good selection would make the planner look better the worse it got. The acknowledgement
rides the same one-turn briefing seam as the original announcement, matched on `atTurn`.

### The blind-spot check

One conditional topic that was **not** selected, sampled at `light` depth (its highest-weight
members). A diagnostic that only asks about the problem the respondent already named can only
confirm what they already believed; sampling one area they did not raise is what makes the result
capable of surprising them.

> **Which two members a `light` topic contains is a whole-system answer, not a per-caller one.**
> `membersAtDepth` picks the top two by item weight when it is given the weight maps and the first
> two authored when it is not — so a caller that omitted them disagreed with the interview about
> what was asked. `buildSessionScope` therefore **loads the weights itself** when a light topic is in
> play and the caller did not supply them. The form used to render the top-two-by-weight while the
> answers guard admitted the first-two-authored, which failed a respondent's submission with
> `QUESTION_NOT_IN_SCOPE` on a question they had just been shown; scoring had the same split, which
> made `assessedItemCount` wrong and silently dropped that respondent from the cohort mean (F17.13).
> A caller already holding the weights — the turn pipeline — still passes them and skips the load.

Forced to `light` regardless of how the topic is authored — its job in _that_ interview is to sample,
not to score — and every surface reporting it must say so. `NotAssessedTopic.partial` carries that
distinction: **"we looked lightly" and "we did not look" are different claims about a respondent.**

### It never throws

Agent missing, no provider, timeout, unparseable JSON, a hallucinated topic key, confidence below
the floor — every one resolves to a plan. A respondent has just finished the opening and is waiting;
a thin interview is recoverable, a spinner that never resolves is not.

When the planner falls back, the respondent message is **dropped**: the model's sentence described
topics the fallback did not choose, and saying it would be a lie.

### The trigger

`maybePlanScope` runs after the turn persists, so the turn's fills are on the row. The write is
guarded on `interviewPlan` still being null, so a retry or double-tap cannot move a plan the
interview is already acting on.

### The opening gate

Planning waits until every member of every opening topic is covered — its data slots filled **and**
its questions answered. Both halves, because judging the opening on its data slots alone made an
opening topic built only from questions read as complete before it had been asked: the plan was
decided on turn one, over an empty transcript.

The cost of deciding early is not only a less-informed judgement. **The hard rules are evaluated at
that same moment**, and `not_exists` matches on absence — so an early gate fires every veto an
author wrote, for every respondent, and the resulting plan looks entirely reasonable. That is the
same failure the reachability checks below catch at authoring time; this is the runtime half of it.

An opening member naming a question that no longer exists is skipped, not waited for. Unresolvable
keys are skipped everywhere in this feature, and here the alternative is a stale member holding
every interview of that version in its opening forever.

The announcement rides the existing **briefing** seam into the phraser, on the one turn following the
decision (`decidedAtTurn === selectionRound`). The interviewer weaves it in its own voice — "based on
what you've said I want to go deeper on pipeline and forecasting" reads as the same person still
talking, where a prepended paragraph reads as a system notice.

---

## The Routing Analyst (F17.4)

Structure extraction reads an uploaded document for its **questions** and discards everything else.
Real instruments carry pages it throws away — "Routing", "Guardrails", "How to use this", facilitator
notes — and those pages are the author stating which parts apply to whom. The analyst reads exactly
the pages the extractor ignored, and proposes the topic set, the criteria and the hard rules they
describe.

It is a **proposer**. Everything lands in `AppQuestionnaireTopicDraft` for review — the same not-live
contract as `AppDataSlotDraft`. The analysis route does **not** fork a launched version (a proposal
is inert); the accept does.

### Grounding is the hard part, not generation

A model asked "what are the topics?" will confidently invent a clean taxonomy from the section
headings, and that answer is worse than useless: **it looks authored, so an admin accepts it, and the
instrument now routes on the model's guess rather than the author's rule.** So the contract makes the
analyst declare which it did:

- **`sourceQuote`** per topic and per rule — the exact span the criteria came from, and **absent
  entirely** when the analyst inferred it. A proposal an admin cannot trace back is one they have to
  re-derive, at which point writing it by hand was less work.
- **`fromDocument`** on the whole set. The review surface renders a different banner for each: "read
  from the document's own routing instructions" versus "inferred from the questionnaire's structure".
- **`maxConditionalTopics`** only when the document states a breadth limit ("no more than three
  areas"). Omitted otherwise — a default here would put the analyst's guess where the author's
  silence was.

Uncovered questions are counted **server-side** before the accept, never trusted from the model.

## Reports and scoring (F17.5)

The `notAssessed` list on the session export is what makes an adaptive instrument honest downstream.

- **The report prompt** carries a scope block that is deliberately **separate** from the
  unanswered-questions block. They license different sentences: a _skipped_ question invites "you may
  want to come back to this"; a _not asked_ topic does not — the interview decided it did not apply
  and told the respondent so, and recommending they complete it contradicts the decision they were
  given. A _sampled_ topic is the subtlest: there is information, it is just too thin to score on.
- **The method record** carries the topics too, so "how this report was created" names them. A
  narrowed interview that reads like a full assessment is the failure this feature exists to avoid,
  and the method panel is the last place it could have been caught. The deterministic template states
  it as well as the agent-written summary, so it survives the explainer being off.
- **Scoring** gains `assessedItemCount` / `totalItemCount` on every `ScaleScore`. No arithmetic
  changes — an out-of-scope item had no answer either way — but the _record_ now separates "asked and
  not answered" from "never asked". `isPartiallyAssessed()` is the question every surface rendering a
  band must be able to ask: **a band from three of eight items is not the same measurement as one from
  all eight**, and a cohort chart that puts them in the same column is comparing two instruments.
- **Cohort statistics exclude a partly-assessed respondent** (F17.13). A scale's mean and band
  distribution are computed only over respondents asked **all** of its items; the rest are counted
  as `partiallyAssessed` and reported beside the figure. Excluding rather than flagging is the
  point: a flagged-but-included score still moves the mean, and a reader who sees a mean does not
  go looking for a footnote before believing it. Where a scale was partial for everyone, the output
  is "not reportable" — deliberately different wording from k-anonymity's "too few respondents",
  because a bigger cohort would not produce the missing number.
- **The author is warned before fielding it** (F17.15). Cohort exclusion is the right behaviour and
  it is silent at authoring time, so `comparability.ts` says on the Topics tab which scales routing
  can narrow — and which ones no plan can ever cover, whose every score will therefore be partial.
  See [Comparability](#comparability--what-routing-does-to-a-score-f1715).
- **The PDF export prints the list itself** (F17.12), under "What this interview did not cover",
  skipped and sampled kept apart. Not gated on any `include` switch: every listing in that document
  is already filtered to what was in scope, so without the note it narrows **silently** and reads as
  a complete assessment of a shorter instrument. The method panel says it on screen; a downloaded
  file outlives the panel, and is the artifact that gets forwarded. The wording is a pure function
  (`export/not-assessed-view.ts`) because React-PDF emits a binary buffer, and a claim this
  consequential must be assertable without parsing a PDF.
- **The admin session viewer** renders the plan above the transcript — what was covered, what was
  not, and what the respondent was told. A conversation that never touched an area reads as an
  oversight until you know it was a decision.

## Routing quality — what actually happened (F17.16)

Every other Adaptive Scope surface is about **intent**: the criteria you wrote, the limits you set,
what a plan would do against an opening you typed. `analytics/routing.ts` is the only account of what
happened when real respondents met them, and it exists because the two failures that matter most
were both invisible.

**A criteria sentence that never fires** produces no error and no empty state. The topic simply never
appears in anyone's interview, and the instrument quietly asks less than its author believes it asks.

**A criteria sentence respondents keep correcting** produces a perfectly ordinary-looking plan. Yet a
respondent asking for a topic the planner left out is the sharpest available evidence that a
version's criteria are wrong — and it was sitting in a JSON column nobody queried.

### A blind-spot sample is not a selection

`chooseCheckTopic` is deterministic — the author's preference, else the **first unselected
conditional topic in authored order** — and `includeCheckTopic` defaults on. So one topic tends to
be seated as a `light` blind-spot check in nearly every plan, for the exact opposite reason to
selection: _because nothing chose it_.

Counting that as selection breaks both headline findings at once. `criteria_never_fires` could never
fire for the one topic it most needs to, and `criteria_always_fires` fired in its place — advising
the author to promote a topic whose criteria never matched to a full-depth always-run topic. So the
row carries `chosen` (`llm` + `rule` — the routing setup decided) apart from `sampled` (`check`),
and the findings read `chosen`. `fallback` counts as neither: it is what happens when there was no
signal to judge on at all.

### A correction is never a success

`selected` excludes `source: 'respondent'` entirely and counts the amendment on its own axis. This is
the reason amendments were recorded twice in the first place (on `InterviewPlan.amendments` **and**
as a `source: 'respondent'` topic): folding a correction into the selection count would make a
version's criteria look better the worse they got. The aggregator reads both records and unions
them, because `amendments` is absent on plans written before it shipped, where the source tag is the
only trace.

`excluded` means "left out and **stayed** out". `applyAmendment` removes an amended topic from the
plan's `excluded` list, so the two counts partition what the planner did not seat: `excluded` is the
decisions that held, `amended` is the ones the respondent overturned.

### Findings are observations, not verdicts

| Code                      | When                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `criteria_never_fires`    | Never included, and never asked for — the invisible failure                |
| `criteria_always_fires`   | Included in every interview — it is an always-ask topic spending a slot    |
| `respondents_keep_adding` | Respondents asked for it themselves in ≥20% of interviews (and at least 2) |
| `budget_decides`          | Chosen by the agent and then dropped for time in most of its exclusions    |

Each carries its sample size, because routing quality is a judgement about intent only the author
can make — a topic that never fires may be a rare-case safety net working exactly as designed.
Nothing is stated below `ROUTING_FINDING_MIN_PLANS` (5), and findings are only ever about
**conditional topics that still exist**: an always-run topic has no criteria to be wrong, and a
deleted one cannot be edited. That threshold is deliberately a separate constant from
`K_ANONYMITY_THRESHOLD` despite sharing its value — one governs disclosure, the other inference, and
sharing the constant would let a privacy change silently redefine what counts as evidence.

### Bounded, and it says so

The card fetches on mount, so this runs on an ordinary Topics-tab visit. `ROUTING_PLAN_READ_CAP`
(2,000) bounds how many plan blobs one read pulls into memory, newest first — and `truncated` says
when it bit, because a silently truncated sample reads as a complete one.

### What never crosses the boundary

A plan carries respondent free text twice — `amendments[].request` in their own words, and the
`rationale` written from it. The aggregator reads neither. Counts and topic keys only, on the same
principle F17.14 settled for the plan preview: an authoring surface is not a place to put respondent
answers. Per-topic rows are withheld entirely below the k-anonymity floor, where a count describes
individuals rather than a pattern. The cohort **size** survives suppression so the surface can say
how far off the threshold it is: "3 interviews so far" identifies nobody, where "topic X was chosen
in 3 of 3" would.

## Auditability

Every plan is recorded as an `AppAiRun` of kind `scope_plan` — **including the ones no model
produced**. A hard rule, the fallback, or an interview with nothing to decide all leave a row, with
`provider`/`model` reading `deterministic` so cost trends stay clean.

"Why did this respondent get those topics" is the question an admin asks about an adaptive instrument
months later, and a deterministic answer is as worth defending as an inferred one.

---

## Breadth and duration are different bounds (C7)

`maxConditionalTopics` caps **how many areas** an interview may cover. It was also being used, by
whoever set it, to mean **how long** — and it cannot carry that.

The client instruction it came from is arithmetic, not preference: a 600-second session, minus what
every respondent gets regardless, leaves an allowance that a certain number of routed topics happens
to fill. "Three" is the answer for one instrument at one budget. Stored as a count, the answer
survives and the question does not — so a client who says "make it fifteen minutes" needs a code
change, and a topic of ten ratings counts the same as a topic of three.

**`sessionBudgetSeconds` is the second bound, not a replacement.** Both apply. `0` means no budget
and is the default, so nothing changes for a version that never sets one. Deliberately, the narrowing
does **not** clamp a small value up to the floor — `5` reads as `0`, because inventing a budget
nobody asked for would quietly start dropping topics.

### Pricing

`scope/budget.ts` is pure and prices per item type, overridable per version via
`secondsPerQuestionType` (data slots are priced as open questions via `secondsPerDataSlot`).

|                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The anchors are the client's**               | 8s a likert, 45s free text. Everything else is interpolated by how much of a decision the type asks for.                                                                                                                                                                                                                                                                                                                                     |
| **A matrix is priced per ROW**                 | It is N ratings wearing one prompt. Costing it as one item is how a 12-row grid ends up looking cheaper than the three likerts beside it.                                                                                                                                                                                                                                                                                                    |
| **An unknown type prices as free text**        | The most expensive guess. Under-costing an unknown is how a budget silently over-fills.                                                                                                                                                                                                                                                                                                                                                      |
| **An unusable override is DROPPED**            | Not defaulted to 0 — a type costed at nothing makes every topic using it look free, the one failure a time budget cannot survive.                                                                                                                                                                                                                                                                                                            |
| **`light` is priced through `membersAtDepth`** | The same resolver the interview uses, so a light topic costs the sample it will actually ask. Duplicating "top two by weight" is how a cost model and a resolver drift apart unnoticed — and the blind-spot check's cost is exactly the number the client's own arithmetic forgets.                                                                                                                                                          |
| **The floor honours depth too**                | `alwaysTopicSeconds` charges an always-run topic at its authored depth, not always at `full`. `resolveScope` applies `depth` to every phase and the editor offers the selector for every phase, so a `light` opening really does ask two items — charging it `full` overstated the mandatory floor, under-reported the routed allowance, and could raise a `budget_below_floor` that blocked launch on a budget that was in fact sufficient. |

These are **estimates and say so**: real durations vary by respondent and by how much someone wants
to talk. The job is to make relative cost visible and the fit decidable, not to predict a stopwatch.

### Where the arithmetic lives

Server-side, in the topics route, shipped on the payload as `costs` — the same reasoning as `issues`:
one implementation, so the number an author reads and the number the planner will work to cannot
disagree. The settings card states it plainly ("about 4m 26s goes to the questions every respondent
gets, leaving ~5m 34s for conditional topics"), which is what turns "no more than three sections"
from folklore into something an author can check.

The one exception is the per-topic `~Ns` on a collapsed topic row, which the browser computes from
the per-item seconds the route already sent. That row shows an **unsaved draft**: a server-sourced
figure would sit there unchanged while an author added three questions, which is worse than none.
It calls the same exported `membersAtDepth`, without weights — the resolver's own fallback — so a
`light` topic may land a few seconds from the server's figure.

Two coherence checks fire on the settings, because a budget below the floor is not a tight interview
but a broken one: `budget_below_floor` (error) and `budget_admits_no_topic` (warning).

### The fit (F17.9)

`applyGuardrails` takes an optional `budget` — the seconds available and every topic's price at both
depths — and drops from the bottom of the plan until it fits. No budget means no fit stage and a plan
identical to the one the same inputs produced before budgets existed, which is what makes this safe
to ship to instruments already running.

|                                     |                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lowest-ranked goes first**        | The last thing seated — the planner's own least confident pick, or the last fallback. The model ordered them; the budget takes them back in reverse.                                                                |
| **A rule-seated topic never drops** | The arithmetic does not get to overrule an author's "always". The plan may exceed the budget for this reason and only this reason.                                                                                  |
| **The check topic is reserved**     | It is chosen from what did _not_ make the cut, so its cost is unknown until the drops settle — hence a re-evaluation each pass. Treating it as free is the omission the client's own arithmetic makes.              |
| **An unpriced topic costs nothing** | A topic with no entry resolves to no members. Charging a guess would drop a real topic to make room for an imaginary one.                                                                                           |
| **The reason is recorded**          | A dropped topic lands in `excluded` with `source: 'budget'` — "there was no time for this" points an author at the setting; "the agent did not pick it" points them at the criteria, and only one of them is true.  |
| **The plan carries the arithmetic** | `budgetSeconds` and `estimatedSeconds` are written onto the plan (and the `AppAiRun` detail), never recomputed on read: the instrument can be edited afterwards, and today's prices answer a question nobody asked. |

An amendment still overrides it. A respondent who asks to be covered on something gets it at `full`
depth whatever the budget says — the same way it already overrides the topic count, and for the same
reason: they are the one spending the time.

The trigger prices the version at planning time (`loadPlanBudget` in `plan-scope.ts`) — two extra
queries, and only for a version whose author set a budget.

---

## Coherence checks

`validateAdaptiveScope` runs on read (the Topics page, the launch checklist) rather than blocking
saves — an admin mid-edit routinely has an incoherent set, and a surface that refuses the save is a
surface they fight.

The check that matters is **`orphaned_questions`**: with scope active, a question belonging to no
topic can never be asked, and nothing else in the system would report it. It is an `error` when the
feature is on and a `warning` when it is off — the second being exactly what an admin needs to see
_before_ flipping the switch.

### Hard-rule reachability

Rules are evaluated at exactly one moment: when the opening completes and the planner runs. A rule
reading a slot the interview has not gathered by then is not a rule that fires later — and only the
**opening** is reliably gathered by then. `core` runs alongside it in an order nothing guarantees;
`conditional` and `closing` topics are, by construction, not in scope until the plan exists.

| Code                       | Severity                   | When                                                                                            |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `rule_slot_unreachable`    | warning                    | No opening topic gathers the slot — the rule never matches                                      |
| `rule_slot_not_in_opening` | warning                    | A `core` topic gathers it — whether it has been asked yet is not something the rule can rely on |
| `rule_veto_always_fires`   | error (on) / warning (off) | A `not_exists` rule reading a slot no opening topic gathers                                     |

**The veto case is the one worth an error.** Absence is what `not_exists` matches on, so an
ungathered slot does not make the rule inert — it makes it fire for everybody. An author who wrote
"never score them on AI readiness when they never named an outcome" gets that applied to every
respondent, and every plan it produces is plausible. Nothing downstream would ever report it.

All three are silent when the version has no opening topic at all: `no_opening_topic` is the finding
to fix first, and one reachability warning per rule on top of it buries the cause.

### Comparability — what routing does to a score (F17.15)

Scoring combines answers into a scale; Adaptive Scope decides which of them get asked. Together they
can compute a scale from a different subset of its own items for every respondent, and
`scoreSession` returns a number either way.

F17.13 made the **reporting** side honest — cohort means are computed only over respondents asked
the whole scale — which has a consequence nobody was told about while authoring: **a scale no plan
can ever cover completely is excluded for every respondent**, and the author finds out when the
cohort report comes back empty, after the instrument has been fielded.

| Code                   | Severity                   | When                                                                                      |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `scale_never_whole`    | warning                    | The scale needs more conditional topics than a plan can seat — by count, or by seconds    |
| `scale_split_by_scope` | warning                    | The scale draws on conditional topics a plan _can_ cover, so some respondents are partial |
| `scale_item_unowned`   | error (on) / warning (off) | The scale scores a key belonging to no topic, so it is never asked                        |

**A stale reference is never an error.** Deleting a question does not prune `AppScoringSchema.content`, so a scoring item pointing at a key the version no longer has is easy to acquire — and impossible to fix from the Topics tab. Making it launch-blocking would strand the admin: the gate would point at a surface where the key is not shown. `scale_item_unowned` stays an error precisely because its key _does_ still exist and _can_ be re-homed there — which is also why it never blocks alone, since the same key already raises `orphaned_questions`. The two are separated by the version's key inventory, and a caller that supplies none gets the warning.

**Rule-included topics do not count against the cap.** `applyGuardrails` seats hard-rule includes **before** the cap and does not truncate them, so a plan can legitimately exceed `maxConditionalTopics`. Counting them would warn that no respondent is ever asked a scale every respondent is in fact asked in full — the exact false alarm this module promises not to raise. A topic a later rule vetoes back out is counted again.

**The count is taken from unavoidable topics, not touched ones.** "Can a plan cover this scale?" is a
set-cover question — an item claimed by two topics is asked if _either_ is seated — and a greedy
answer can overstate what is needed. Overstating here means telling an author "no respondent is ever
asked all of this" when one might be, so the count comes from items with exactly **one** owning
topic. Those topics are in every cover, which makes the number a lower bound and the finding
incapable of crying wolf. `scale_split_by_scope` uses the wider touched-topic count, because there
the claim is only that some respondents will be partial — which is true either way.

`light` depth is deliberately not modelled: a topic seated as the blind-spot check contributes two
members, so a scale drawing on it is partial even when the topic _is_ seated. That makes
`scale_split_by_scope` an understatement rather than an overstatement, and the fix it points at does
not change.

These run whether or not `enabled` is set. "What would routing do to my scores" is a question that
has to be answered before the routing starts.

### Duplicate membership

A question claimed by two topics is tolerated at runtime — asked if either is in scope, attributed to
the first in-scope topic in ordinal order — but it is not free. `estimateTopicCosts` prices each
topic independently and `alwaysTopicSeconds` sums them, so a shared member is **charged once per
claiming topic**: the floor comes out too high, the routed allowance too low, and the fit drops
topics that would in fact have held. `duplicate_membership` is a warning, reported regardless of
`enabled`, and aggregated per kind so a copied topic produces one finding rather than forty.

---

## Files

| Path                                                                | What                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/app/questionnaire/scope/types.ts`                              | Vocabulary, settings, plan shape, narrowers. A **leaf** — it carries its own `narrowToEnum` copy so `types.ts` can hold an `AdaptiveScopeSettings` without a runtime import cycle |
| `lib/app/questionnaire/scope/resolve.ts`                            | The pure filter                                                                                                                                                                   |
| `lib/app/questionnaire/scope/rules.ts`                              | Hard-rule evaluator                                                                                                                                                               |
| `lib/app/questionnaire/scope/guardrails.ts`                         | Cap, fallback, the time fit, check topic                                                                                                                                          |
| `lib/app/questionnaire/scope/budget.ts`                             | What an interview costs in seconds — per-type pricing, per-topic cost at both depths, the floor and the allowance                                                                 |
| `lib/app/questionnaire/scope/planner.ts`                            | The model call; never throws                                                                                                                                                      |
| `lib/app/questionnaire/scope/amendment.ts`                          | Cue gate, label match, plan mutation (F17.6) — pure                                                                                                                               |
| `lib/app/questionnaire/scope/analysis-schema.ts`                    | The Routing Analyst's output contract                                                                                                                                             |
| `lib/app/questionnaire/scope/analysis-prompt.ts`                    | Its rubric — mostly about quoting versus inferring                                                                                                                                |
| `lib/app/questionnaire/capabilities/analyse-routing.ts`             | The analyst capability                                                                                                                                                            |
| `lib/app/questionnaire/scope/seed.ts`                               | One topic per section, pure                                                                                                                                                       |
| `lib/app/questionnaire/scope/validate.ts`                           | Coherence findings                                                                                                                                                                |
| `lib/app/questionnaire/scope/comparability.ts`                      | What routing does to a scoring scale (F17.15) — which scales it can narrow, and which no plan can ever cover                                                                      |
| `lib/app/questionnaire/analytics/routing.ts`                        | Routing quality (F17.16) — what the planner actually did across a version's interviews, and the findings the counts support                                                       |
| `app/api/v1/app/questionnaires/_lib/session-scope.ts`               | The DB seam                                                                                                                                                                       |
| `app/api/v1/app/questionnaires/_lib/seed-topics.ts`                 | Seeding + reconcile-after-rewrite                                                                                                                                                 |
| `app/api/v1/app/questionnaire-sessions/_lib/plan-scope.ts`          | The post-turn trigger                                                                                                                                                             |
| `app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/route.ts` | GET / PUT / PATCH                                                                                                                                                                 |
| `.../topics/preview/route.ts`                                       | The plan dry-run (F17.14) — the planner over a synthetic opening; writes nothing                                                                                                  |
| `.../analytics/routing/route.ts`                                    | Routing quality (F17.16) — per-topic selection / exclusion / amendment counts over the window                                                                                     |
| `app/api/v1/app/questionnaires/_lib/plan-inputs.ts`                 | The shared version-side planner inputs, so the dry-run and the interview price the instrument identically                                                                         |
| `.../topics/analyse/stream/route.ts` · `.../topics/draft/route.ts`  | Run the analyst (SSE) · accept or discard its proposal                                                                                                                            |
| `app/api/v1/app/questionnaire-sessions/_lib/amend-plan.ts`          | The amendment trigger                                                                                                                                                             |
| `components/admin/questionnaires/topics/**`                         | The Adaptive scope tab: explainer, settings, rules, topic editor, analyst review                                                                                                  |

## Try it — the plan preview (F17.14)

**Every other check on this tab is structural.** `validateAdaptiveScope` says the configuration is
well-formed; the cost table says what it would take. Neither says which topics a respondent actually
gets — and for a feature whose premise is "the model makes a judgement you cannot fully specify in
advance", that left the author's only feedback loop a complete interview run as a respondent, with
the plan inferred backwards from what got asked.

`POST …/topics/preview` runs the real planner over an opening the author types and returns the plan
the current settings would produce. It writes nothing: no session, no plan, no draft.

### What it has to show beyond the plan

A plan alone is not a diagnosis. An author looking at a topic that missed the cut needs to know
**which layer dropped it**, because each one points at a different fix — the criteria, the cap, the
seconds, or the rule. The plan already carries that: `PlannedTopic.source` and `ExcludedTopic.source`
name the decider for every topic in and out.

The one thing the plan cannot carry is the difference between _the model never picked this_ and _the
model picked it and a guardrail took it back_ — which is precisely the distinction between "your
criteria are wrong" and "your limit is too tight". So the response carries `proposedKeys` beside the
plan, read from the planner's own pre-guardrail output snapshot.

**That signal has to OVERRIDE the stored record, not sit beside it.** A proposal the cap trims is
written to `excluded` with `source: 'llm'` and the rationale _"Not selected — nothing in the opening
pointed at this area"_ — which is the opposite of what happened, and an author who believes it
rewrites criteria that worked. Only `proposedKeys` can tell the two apart, so where it says the agent
chose a topic, the card replaces both the badge and the rationale.

The excluded list also needs **its own vocabulary**. `SCOPE_DECISION_SOURCE_LABELS` was written for a
topic that made it in, where `llm` reads "Chosen by the agent"; on an excluded topic that same value
means the exact opposite, so reusing it badges every ordinary non-selection "Chosen by the agent"
directly under the heading "Not in this interview".

### Naming the layer when it was not the agent

`skippedModelReason` covers the paths where the plan was not the agent's judgement, and the
distinctions are finer than "was a model called":

| State                      | How it is told apart                       | Why it needs saying                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing to decide          | no provider, `confidence: 1`               | Reporting an unreachable agent here sends an author debugging one that is healthy                                                                                                                                           |
| The call failed            | no provider, `confidence: 0`               | The genuinely unreachable case                                                                                                                                                                                              |
| Below the confidence floor | **provider present**, `source: 'fallback'` | A check on "was a model called" misses this one entirely — and it is the most confusing state to land in unexplained, because the model's own picks sit in the excluded list rationalised as though nothing pointed at them |

### Synthetic, and the fills are hand-set

The author supplies the answers **and** the data-slot fills. In a live interview a fill is an
extraction FROM those answers, so a hand-set fill is a hypothesis rather than a prediction, and the
panel says so rather than leaving it to be discovered.

Running the real extractor over the typed answers would be more faithful and much slower — and it
would make the one demonstration that matters _harder_: a `not_exists` veto fires on an **absent**
fill, and absence is exactly what an author needs to be able to set by hand. The slots a veto watches
are marked in the form, and leaving one empty is presented as a deliberate act rather than an
unfinished field.

Replay over real completed sessions was considered and deliberately not built: it would put
respondent answers into an authoring surface, and the author's own phrasing — the phrasing least
likely to break the routing — is a cost worth naming rather than a gap worth hiding.

### Why it records no `AppAiRun`

`ai-run/types.ts` is explicit that interactive previews an admin is merely exploring with are not
provenance: nobody acts on the verdict, it changes no durable config, and it is not an output anyone
would defend to a client. The spend stays visible without it — `planScope` routes every call through
`logCost`, and the route passes a `preview:<versionId>` reference so those rows stay separable from
real interviews. A per-admin sub-cap (`scopePreviewLimiter`, 20/min) bounds a button that is _meant_
to be pressed repeatedly.

### One loader, two callers

The live trigger and the dry-run must not assemble the version differently — **a preview that prices
or projects the instrument differently from the interview is a preview that lies**, and it would lie
quietly. Both now go through `loadTopics` (`_lib/topic-routes.ts`) for the topic projection and
`loadPlanBudget` (`_lib/plan-inputs.ts`) for the pricing. The session-side half legitimately differs:
one reads fills and answers off a real session, the other takes them from a form.

---

## The authoring surface

Three things about the tab are load-bearing rather than cosmetic.

**The page teaches an order the controls cannot.** Adaptive scope only works if it is authored in a
sequence — group every question into a topic, mark the conditional ones, pin the certainties, then
switch on — and an admin who flips the switch first gets a questionnaire that behaves exactly as it
did before, with nothing on screen explaining why. `ScopeExplainer` states that sequence at the top
of the page. It starts collapsed — heading and one-line summary only — and its open/closed state is
deliberately not persisted anywhere: expanding it is a momentary "remind me what this page is"
gesture, not a preference about how the page should look, so it is plain component state that resets
on the next visit. An earlier version remembered it in `localStorage`, which meant expanding it once
to read it kept the full panel open on every questionnaire afterwards.

**The settings card is ordered by the runtime, and numbered to say so.** Hard rules sit first
because they really are evaluated before the agent; the cap and the confidence floor sit after
because they really are applied to the agent's answer. The failure this ordering prevents is an
admin reading the cap as a request the model tries to honour — seeing it sit downstream of the
model's turn, in a sequence they cannot reorder, is the cheapest way to say it is enforced.

**Topic rows collapse.** Ingest seeds one topic per section, so the common first sight of the page
is fifteen-plus topics; as fifteen open forms it is a page you scroll rather than read. The
collapsed line carries what a skim is actually for — name, phase, size, criteria — plus everything
wrong with the row (no criteria on a conditional topic, a duplicate key, a member key that no
longer resolves), so a problem is never hidden behind a chevron. Reordering is disabled while a
filter is applied, because "move up" means "swap with the row above" and with rows hidden the row
above on screen is not the row above in the set.

The copy throughout is deliberately client-neutral. The capability was generalised from one client's
routing requirement, and examples drawn from that instrument would read as the intended shape;
every illustration on the page is instead drawn from a different kind of instrument — a screener, a
compliance audit, a role-specific survey.

## Related

- [`../planning/features/f17.1.md`](../planning/features/f17.1.md) onward — the trackers
- The pilot client research notes (held outside this repo) — the client
  requirement analysis this capability was generalised from
- [`experiences.md`](./experiences.md) — routing _between_ questionnaires, the sibling mechanism
