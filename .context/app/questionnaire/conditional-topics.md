# Conditional Topics

**Which parts of a questionnaire apply to this respondent, and who decides.**

ConQuest already decides two things: **which question next** (selection strategies) and **which
questionnaire next** (the Experience switcher). Conditional Topics is the gap between them. Screeners,
eligibility checks, role-specific question sets, compliance sections that must be recorded as
not-applicable, and any long instrument that should not ask all of itself to everyone are all the
same requirement — and before P17 the only way to express it was to split the questionnaire into
several, which costs cross-section scoring and cohort analysis.

> **Status:** F17.1–F17.24 shipped — the model, the runtime, the planner, the authoring
> surface, the Routing Analyst, report/scoring awareness, respondent amendment, the plan preview,
> routing-quality analytics, the opening's follow-up allowance, the scope judge panel (F17.21),
> and the defect fixes the first real imported instrument exposed (F17.23).
>
> The tab simplification is complete: F17.24 de-risked it, F17.25 added the status header and
> moved the master switch out of the tenth card, F17.26 split it into three sub-tabs, F17.27 swept
> the remaining implementation vocabulary off the screen, and F17.28 mirrored the master switch
> onto the Settings tab.

### It was called "Adaptive Scope" until 2026-08-25

Everything below — the feature, the tab, the settings block, the docs — used to be named **Adaptive
Scope**. That name described the mechanism (a scope that adapts) rather than the thing an admin
authors, which is a set of topics, some of them conditional. Commits, PRs and the `f17.*` trackers
written before the rename use the old name; this document and the code no longer do.

The rename went all the way down, so there is no half-renamed layer to remember:

| Layer                   | Then                                             | Now                                         |
| ----------------------- | ------------------------------------------------ | ------------------------------------------- |
| Config column           | `AppQuestionnaireConfig.adaptiveScope`           | `.conditionalTopics` (renamed by migration) |
| Candidacy column        | `AppQuestionnaireVersion.adaptiveScopeCandidate` | `.conditionalTopicsCandidate`               |
| Capability slug         | `app_detect_adaptive_scope_candidacy`            | `app_detect_conditional_topics_candidacy`   |
| Audit action            | `questionnaire_adaptive_scope.update`            | `questionnaire_conditional_topics.update`   |
| Instrument export field | `adaptiveScope`                                  | `conditionalTopics`                         |

Both columns were renamed **in place**, so every configured version stayed configured and no
back-compat read shim exists anywhere — a column rename cannot leave a row behind. The two places a
pre-rename name can still arrive from outside are handled explicitly: a definition file exported
under the old name still imports (`parseDefinitionImport` folds `adaptiveScope` into
`conditionalTopics`), and seeded rows carrying the old wording are re-worded on the next seed run
(`090` renames its own slug in place; `097` re-words the operator-facing text). Audit rows written
before the rename keep the old action string, because history is not rewritten.

### The tab is called "Conditional topics"; the URL segment is still `topics`

The capability is what an admin is looking for in the tab bar, and "Topics" named only the unit it
edits — a noun that collides with the data-slot `theme` and with the orchestration analytics
"topics" page, and that says nothing about conditionality. The label now matches the vocabulary
every other surface already used (the settings card, the launch-checklist item, the session viewer,
this document).

The route stayed `…/v/[vid]/topics`: renaming it would break bookmarks and the launch checklist's
deep link for no behavioural gain. Component and payload names (`TopicsPanel`, `TopicsPayload`,
`getVersionTopicsCached`) follow the route, not the label — as do the `scope/` module directory and
the runtime's own `SessionScope` / `resolveScope`, which name what the planner computes (the part of
the instrument in scope for one respondent) rather than the feature.

---

## The one invariant

**Off by default, inert by construction.**

`conditionalTopics.enabled` defaults `false`, every auto-seeded topic is `core` (always asked), and
`resolveScope` short-circuits to full scope on either condition. A version that never opts in cannot
reach a single new runtime code path — `buildSessionScope` does not even query the topic table.

That equivalence is a tested gate, not a hope: `turn-context.test.ts` asserts both the unchanged
output and the absent query.

---

## The four concepts

| Concept            | What it is                                                                                                              | Where it lives                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Topic**          | The conditional unit: a named group of question + data-slot **keys**, with a phase, plain-English criteria, and a depth | `AppQuestionnaireTopic`                 |
| **Hard rules**     | A short optional list checked before the agent — the cases the author is certain about                                  | `conditionalTopics.rules` (config Json) |
| **Scope Planner**  | Runs once, when the opening completes: rules → judgement → guardrails                                                   | `scope/planner.ts`                      |
| **Interview Plan** | The per-session record: which topics, which not, why, and what the respondent was told                                  | `AppQuestionnaireSession.interviewPlan` |

### Size is not significant

A topic may hold thirty questions or one — and **a one-question topic is how a fine-grained
interdependency is expressed** ("ask this single question only when the respondent said X").
That is why there is no second `showIf` expression language: the coarse and fine cases are the same
mechanism at different sizes, so an author learns one thing and we maintain one evaluator.

### Membership is keys, never row ids

`members` holds `{ dataSlotKeys, questionKeys }`. That is what lets a topic survive a version fork
with **no re-linking at all** — `copyVersionGraph` copies topics verbatim and they land on the copied
questions, because those carry their keys over 1:1. It also keeps an `AppAiRun` snapshot legible.

Unresolvable keys are silently skipped everywhere. An author deleting a question a topic still names
must never break a live interview; `validateConditionalTopics` surfaces it on the authoring surface,
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

**The cue gate is English, so a non-English version gets a different first tier (F17.29).**
`AMENDMENT_CUES` is a list of English phrasings. On a version whose `audience.locale` says the
interview is held in another language — a configuration the product already supports, since the
interviewer is instructed to respond in that language — the gate could only ever return false,
silently, on every turn, for the whole feature.

The fix is not a translated cue list: authoring cue phrasings for every language the product might
be run in is work nobody here can check, and a bad list fails the same silent way. What _is_
language-neutral is the **topic labels**, written in the instrument's own language by whoever wrote
the instrument. So a non-English version gates on "does this message name an excluded topic"
(`candidateLabelHits`), and a hit goes **straight to the model tier** — never to the deterministic
label match. Naming a subject is not asking for it ("we sorted talent last year"), the cue list is
what tells those apart in English, and with no cue list that judgement is the agent's. The prompt is
told the message and the labels may be in different languages.

The cost moves rather than disappearing: an English version still pays **nothing** on an ordinary
turn (the locale is passed in from the turn context, so the gate needs no query), and a non-English
version pays **one indexed query** per turn and a model call only when a topic was named.

**It only ever adds.** A respondent declining a topic the instrument requires is a different feature
with different consequences — partial scoring, an incomparable cohort — and quietly allowing it here
would make every completed assessment mean something slightly different.

The amendment is recorded on the plan (`InterviewPlan.amendments`) _and_ the added topic carries
`source: 'respondent'`. Routing analytics must be able to tell the two apart from a planner success:
**a correction is evidence about the planner, not an example of it working**, and counting an amended
topic as a good selection would make the planner look better the worse it got. The acknowledgement
rides the same one-turn briefing seam as the original announcement, matched on `atTurn`.

### A plan may ask part of a topic (C6, F17.29)

`depth` is a dial with two stops — all of it, or the two highest-weight members — and no way to say
_which_ items. That covers the blind-spot check exactly, which is why the pilot instrument works,
and it cannot express "three of these ten questions are the reason this topic fits this respondent".

`PlannedTopic.members` is that expression: an optional explicit subset, absent on nearly every
planned topic. Three rules make it safe to have:

- **It can only narrow.** The subset is intersected with what the topic actually claims, in
  **authored order** — a plan never widens a topic into questions its author did not put in it, and
  never reorders the instrument to match the order a model listed keys in.
- **An empty intersection falls back to the depth.** A planner naming items that do not exist is the
  same class of mistake as naming a topic that does not exist, and gets the same treatment. "In
  scope and asks nothing" would be a topic that reports as covered while contributing no answer —
  worse than asking more than strictly necessary, which is the direction every degradation in
  `resolve.ts` takes.
- **Narrowing one half says nothing about the other.** A subset naming only questions leaves the
  topic's data slots at their depth.

**The fit prices what it will actually ask.** `plannedSeconds` takes the per-item seconds and costs
a subset on the items it names; charging `full` for a three-of-ten topic drops one that would have
fitted and shows the author a budget that lies. Without those prices — a caller that supplied only
the per-depth costs — a subset is charged at its depth, which over-states rather than under-states.
That is the safe direction: it drops a topic rather than overrunning the respondent's time.

**What the planner is shown, and what it costs.** A candidate's questions are listed in the prompt
(key plus wording) so the model can name them, bounded three ways: `MAX_PLANNER_ITEM_CHARS` per
question, `MAX_PLANNER_ITEMS_PER_TOPIC` per topic, and `MAX_PLANNER_RENDERED_ITEMS` across the whole
prompt, spent best-candidate-first. A topic whose items do not fit that budget is printed as
_"questions: not listed — choose this topic whole or not at all"_ rather than having its first
twelve shown, because a subset chosen from an arbitrary window is worse than no subset at all. The
prompt sets a high bar for using it: the named items must be _the reason the topic was chosen_, not
the ones that look most interesting.

The admin session viewer shows "3 of 10 asked" beside a narrowed topic. "We covered Talent" and "we
asked three of Talent's ten questions" are different claims, and a challenged report turns on which
one was true. The count is against what the topic holds **today** — the instrument can be edited
after an interview runs, and a total stored on the plan would answer a question nobody puts.

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

## What the opening may spend (G03 / F17.17)

The opening is the only part of the interview whose answers decide the rest, which makes its
follow-ups both the most valuable questions in the instrument and the most expensive. Every
follow-up spends a turn the plan could have spent on a routed topic — in the pilot client's own
arithmetic, roughly a section each. Their guardrail was blunt about it: **one probe for the whole
opening**, and only when the answer is too abstract to route.

### A probe is a follow-up, and `maxDataSlotAttempts` cannot ration it

The interviewer re-asks a data slot when what came back was not confidently captured — the
`isReask` path in `data-slot-orchestrator.ts`. `maxDataSlotAttempts` bounds that **per slot**, which
is the wrong unit for this: a per-slot cap has no idea a follow-up was already spent three questions
ago. `conditionalTopics.maxOpeningProbes` is the shared allowance across the whole opening.

Two fields rather than one — `limitOpeningProbes` (the switch, off) and `maxOpeningProbes` (the
number, 1). `0` is a meaningful setting here ("never follow up"), so unlike `sessionBudgetSeconds`
it cannot double as the off switch.

### It only ever lowers a cap, and the mechanism is the park

When the allowance governs the active slot, the effective re-ask cap becomes
`1` — a probe the opening cannot afford (the allowance is spent) or should not spend (the answer is
already routable). Otherwise the author's own `maxDataSlotAttempts` governs, untouched. A probe the
opening cannot afford therefore becomes an
ordinary **park** — a provisional fill and a bridge to a fresh area — which the runtime already knew
how to do. No new response kind, and no new way for an interview to stall.

The cap is only ever lowered, never raised, so an allowance of five cannot make an interview ask a
question the author's own per-slot cap forbids — a slot already at that cap fails the
`attempts < cap` guard and never consults the allowance at all.

**The allowance is counted down once, by `spent`, and nowhere else.** An earlier revision also
lowered the cap to `1 + remaining` on the affordable path. That double-counts: the follow-up being
authorised right now will itself increment `spent`, so the next turn's `remaining` is already one
lower and parks the slot then. Subtracting a second time retired the allowance a turn early, and an
author who asked for three probes silently received two. The bug was invisible at `maxOpeningProbes:
1` — where the two arithmetics agree — which is why it survived the first round of tests.

### Spending the probe on an already-routable answer is the failure

"We want things to run better" is worth a follow-up. "Our handovers stall waiting for one person to
sign off" names a section on its own, and probing it wastes the only probe the opening has. So
before a probe is spent, `assessOpeningRoutability` asks whether the plan could already be decided
from what has been said — against **the author's own criteria**, which is the only test that means
anything.

It runs on the **planner's own agent binding**, at the `routing` tier rather than the planner's
`reasoning` tier. Same agent because the check is a prediction of that agent's own judgement, and a
second agent could disagree with it about the very question the check exists to anticipate; a
different tier because this one runs _inside_ a live turn while the respondent watches a typing
indicator, so its timeout is 6s against the planner's 12s.

**Failure leans one way only.** `assessOpeningRoutability` returns `null` for a missing agent, an
unresolved provider, a timeout or an unparseable reply — and `null` is not `false`, and certainly
not `true`. The caller spends the probe on a null, which is exactly what the interview would have
done before this existed. The check may only ever _save_ a question, never skip one on the strength
of a call that did not happen.

### The count is derived, never stored

`spent` is read off the turn record: opening-slot turns minus distinct opening slots, i.e. the
second and every later question about the same thing. That is self-healing in a way a counter column
is not — a turn that never persisted never spent a probe, and no bookkeeping has to remember it. It
also counts a _return_ to a slot the interview had moved on from, which costs the respondent exactly
as much as a consecutive re-ask.

The read is over the **full** turn history for those slots, not the windowed transcript the loader
already holds: an allowance read off a window would quietly refill itself on a long opening.

### What it costs everyone else

Nothing. `buildTurnContext` resolves an allowance only when the version opted in, the plan is not
yet decided, and an opening topic names data slots that exist — one extra query, for those turns
only. The classifier is called at most once per **turn**, at the moment a probe is about to be
spent: never on a first ask, never on a covered slot, and never when the allowance is already
exhausted (there is nothing to decide, so nothing is paid to decide it).

Once per turn, not once per session — a `routable: true` verdict withholds the follow-up without
spending a probe, so the next opening slot whose answer lands weakly asks again. An opening of six
slots answered routably throughout costs six checks across six turns. That is bounded by the
opening's length rather than by the allowance, and it is the one place this feature can cost more
than it saves; if it ever bites, the fix is to remember a `true` verdict for the session rather than
to shorten the timeout.

### What is deliberately not built

**Nothing prices the interviewer's own turns.** The session budget (C7) prices the _questions_; a
probe is a turn, and the two are not yet reconciled. The allowance bounds probes by count for the
same reason `maxConditionalTopics` bounds topics by count — it is the honest thing to enforce
without pricing what has never been measured.

**The allowance covers data slots only.** An opening built from form questions is not rationed, and
the tab says so (`opening_probe_limit_inert`) rather than leaving the author to discover it.

---

## The Routing Analyst (F17.4)

Structure extraction reads an uploaded document for its **questions** and discards everything else.
Real instruments carry guidance it throws away — routing and eligibility notes, guardrails, "how to
use this" instructions, facilitator notes, wherever in the file the author put them — and that
guidance is the author stating which parts apply to whom. The analyst reads exactly what the
extractor ignored, and proposes the topic set, the criteria and the hard rules it describes.

The wording throughout this surface is deliberately agnostic to both **document format** and
**subject matter**: the guidance may sit in a preamble, an appendix, a sidebar, a separate sheet or
section, or a note beside the questions, and the instrument may be about anything. Copy, prompts and
seeded agent instructions must not assume a shape (no "the Guardrails tab") or a domain.

It is a **proposer**. Everything lands in `AppQuestionnaireTopicDraft` for review — the same not-live
contract as `AppDataSlotDraft`. The analysis route does **not** fork a launched version (a proposal
is inert); the accept does.

### The documents it reads — the instrument, and its companions (F17.29)

An instrument does not always arrive as one file. A question bank plus a separate routing memo used
to be inexpressible: the only way to put a second document on a version was a **re-ingest**, which
replaces the structure extracted from the first. So the analyst read the memo and lost the
questions, or read the questions and never saw the routing rules it exists to find.

`AppQuestionnaireSourceDocument.role` now says what each row IS:

| Role            | Written by                        | What it means                                                    |
| --------------- | --------------------------------- | ---------------------------------------------------------------- |
| `primary`       | ingest / re-ingest                | the document the version's questions were extracted from         |
| `supplementary` | `POST …/versions/[vid]/documents` | a companion an admin attached; carries guidance, never questions |

The analyst reads **the newest primary** — re-ingest appends rather than replaces, and the older row
describes an instrument that is no longer the one being asked — followed by every supplementary row
in **attachment order**.

**There is no way to POST a primary document.** That role belongs to the two routes that extract a
structure from it in the same pass; a primary row written without one would claim the version's
questions came from a document they did not come from. Symmetrically, DELETE refuses a primary row:
it is the provenance record for questions that already exist.

**Only the companions are budgeted.** `MAX_SUPPLEMENTARY_DOCUMENT_CHARS` (40,000) is shared across
them, oldest first; the primary document is passed **whole**, exactly as every run before this one
carried it. Bounding it here would change what the analyst proposes on versions nobody has touched.
A companion that overruns is cut at a **marked seam** and the prompt says so — the analyst is told
not to quote across it, and to report that it did not see all of the document. One that the budget
cannot reach at all is **named but not shown**, for the same reason: a proposal that silently missed
a routing page is the failure this feature exists to end.

**Where they disagree, the analyst reports rather than resolves.** A companion is guidance about the
instrument, not a second instrument — the prompt says so, forbids inventing a question key from it,
and instructs it to put a genuine contradiction in `gaps[]` quoting both sides. That is the same
restraint the corpus's document 08 tests.

**Documents now fork with the version.** They did not before, and the consequence was silent: fork a
launched version and the analyst — whose whole job is to read the author's own guidance — had none
to read, so it inferred from question wording and reported `fromDocument: false`. `copyVersionGraph`
copies every row, `createdAt` included, because the readers order by it.

The ingestion-time **candidacy check** still reads the primary document only. It runs during upload,
before any companion can exist, and an admin who has gone to the trouble of attaching a routing memo
has already answered the question that check asks.

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

### Two settings the analyst may propose, and one it may not (F17.23)

The analyst's output used to carry topics, rules and `maxConditionalTopics` only. But a document's
routing prose routinely states two other things, and with nowhere to put them the analyst reported
them as unformalizable `gaps` — a proposal admitting defeat about settings the platform had
implemented all along:

- **`fallbackTopicKeys`** — the safe default when the planner chose nothing at all. Folding this
  into topic criteria instead (which is what the analyst used to do) is not the same behaviour:
  `applyGuardrails` fires the fallback list **only** when nothing was seated, whereas criteria put
  those topics into ordinary competition against the limit.
- **`checkTopicPreference`** — which area is worth sampling as the blind-spot check.

Both are optional and **omitted when the document is silent**, the same discipline
`maxConditionalTopics` follows, so a default never lands where the author said nothing. Both are
capped at 5 in the analyst's contract; the accept path caps at 20 to match the settings PATCH,
because both paths write the same field.

**Membership is enforced on the way out, not at the schema.** A key naming no proposed topic is
dropped in `narrowProposedTopicSet` rather than refused by `routingAnalysisSchema`. An unknown key
is inert at runtime — `chooseCheckTopic` and the fallback loop both skip what they cannot resolve —
so refusing the whole response over one would throw away an otherwise-good proposal and pay for a
retry to fix a hint.

**`plannerInstructions` is deliberately not proposable.** It is prose steering the model, and an
analyst writing its own steering is a loop worth not building. Authors write it by hand, and the
proposal's `gaps[]` is the better prompt for what it should say.

### The depth correction — fixed on the way in, but never silently (F17.23)

`narrowProposedTopicSet` coerces `light` → `full` on any always-run topic and records the corrected
keys in `depthCorrectedKeys`, which the review card renders as an amber note.

Corrected rather than refused at the schema, on purpose: a hard `.refine` would throw away an
otherwise-good fifteen-topic proposal — and pay for a second model call — over one field, and the
analyst has produced exactly this mistake on real instruments. Corrected **and** reported, because a
silent fix would leave an admin unable to learn that their document's wording invited a proposal
that drops questions. The prompt now forbids it too (see `## Depth` in `analysis-prompt.ts`); the
coercion is the belt to that braces.

### Gaps — what the proposal admits it left out (F17.19 Phase 2)

The rubric above is about the analyst being right; `gaps` is about it being **honest when it isn't
sure**. Real routing prose does not always cleanly become a topic or a hard rule — a condition names
something no data slot captures, an instruction contradicts another one, or the document just says
"use judgement" for the cases it does not enumerate. Before this, that language was silently dropped:
the proposal looked complete, and an admin had no way to know the document said more than it covered.

`gaps[]` is a small, capped (15) list where each entry is `{ sourceQuote, explanation }` — and unlike
a topic or rule, **`sourceQuote` is never optional**. A gap that cannot be traced to the document's own
words is not a gap; the whole point of the field is admitting what the document said, not inventing a
new proposal. The review surface renders these separately from the topic/rule list, under "Recognized
but not formalized" — accepting the proposal does **not** cover them, and the admin decides whether to
add a topic, a criterion, or a rule by hand.

**"Turn into topic" (F17.20)** shortens that last step without pretending to finish it. Each gap
carries a button that seeds a new draft row in the topic list below — `criteria` from the gap's
`sourceQuote` (the document's own words), `description` from its `explanation` (why the analyst
couldn't formalize it, kept as a note for whoever finishes the row) — expanded and scrolled into view.
Nothing is inferred beyond that: the row has no label, no members and defaults to `conditional`, so
the admin still names it, picks its questions and data slots, and reviews the wording before it is
part of the set. Purely a local seed into the editor's unsaved draft — it writes nothing until the
admin saves the topic list, same as adding a topic by hand.

### Finding out it exists (F17.19)

Everything above used to be entirely **manual** — an admin had to already know the tab exists and
click "Run". A cheap, fail-soft candidacy check runs during ingestion itself (all four entry points:
new ingest + re-ingest, plain + streaming) and decides, at the fast `routing` tier rather than this
analyst's `reasoning` tier, whether the document's own words describe conditional routing at all. The
verdict is recorded (`AppAiRun` kind `scope_candidacy`) and cached on the version.

The Topics tab now acts on it: when the cached verdict says a fresh, untouched version is a
candidate, `RoutingAnalystCard` invokes the same analyst run the "Run" button makes, on its own, the
first time the tab is opened — so an admin who discovers the feature by opening the tab at all finds
a reviewed draft already waiting rather than an empty card. A banner names why it started. Nothing
here auto-enables `conditionalTopics.enabled` or writes to the live topic set; a proposal is still only
ever accepted by hand. The "already tried" signal that stops a discarded auto-proposal from
re-proposing itself on every visit is the analyst's own `AppAiRun` (kind `routing_analysis`), not a
new column — see [`f17.19.md`](../planning/features/f17.19.md) for the full phased history. Phase 4
put the routing logic itself into the [Questionnaire Pack](./questionnaire-pack.md) — an off-by-default
"Conditional topics" section that explains the topics, criteria, and hard rules in plain language for a
stakeholder audience, distinct from every other Conditional Topics surface (all authoring tools, not
distribution artifacts).

### When the check says no (F17.22)

The candidacy check answers "does this document **say** it routes", not "could this instrument
usefully route" — its rubric forbids inferring conditionality from question variety and tells it to
answer `false` when in doubt. That bias is right for an unattended auto-run, and it left two holes:

- **A negative verdict used to render nothing.** The card's banner was gated on
  `candidacy?.isCandidate`, so "we checked and found no routing instructions" drew no pixels — and an
  admin who did not already know the card existed had no reason to look at it, in exactly the case
  where they most need telling. The card now states the verdict either way (and distinguishes
  "checked and found nothing" from "never checked"), and says the analyst can still propose
  conditional topics from the questions alone. It can: the analyst's own rubric permits it and
  reports it as `fromDocument: false` on the proposal, with a warning to check every criterion.
- **The only button was several screens from the work.** The analyst card sits above the settings,
  the preview, the quality card and the evaluation card. An admin scrolling the topic list to decide
  which groups are conditional is authoring by hand exactly what the analyst authors, and had nothing
  to press. The Topics section header now carries **"Set up conditional topics with AI"**, which asks
  the card to run and scrolls the admin to it — one place a proposal is still reviewed and accepted.

`runRequest: { nonce }` / `onRunHandled` is the same request-prop contract `focusTopic` and
`seedTopic` use, and for the same reason: pressing twice must act twice. **A pending proposal is
never overwritten by one of these** — the request scrolls to it and stops, because the admin has
unreviewed work there and a silent re-run would discard a review in progress.

None of this touches the invariant. A proposal is inert until accepted, and `enabled` still moves
only when an admin moves it.

### Closing the loop to the switch (F17.22 Phase 4)

Accepting a proposal wrote conditional topics and left the feature off, which is correct — and left
the version in a state nothing outside this tab described: **topics authored with conditions on
them, and every one of them asked to everybody.** The AI chain had succeeded; the product simply
never said the configuration was inert. Two surfaces now say it.

**A warning on the launch checklist.** `launchReadinessChecks` gains an `conditionalTopicsOff` row —
"Conditional topics is off, so all 4 conditional topics are asked to everyone" — shown only when the
feature is off AND the version has ≥1 conditional topic. It is the mirror of the `conditionalTopics`
coherence row, which appears only when the feature is on.

It is also the first check on that list that does **not** block a launch, and that required a real
change rather than a `false` in the right place. Readiness was computed in four places, each with
its own `!c.ok`: `isLaunchReady`, the server `loadLaunchReadiness`, the status route's launch gate,
and the checklist UI. A row that means "look at this" would have become a row that means "you may
not launch" in three of them. So every check now carries an explicit `severity`, and one exported
`blocksLaunch(check)` is what all four ask. Explicit on every check rather than optional-with-a-
default: a new check must state that it blocks, instead of blocking by accident or — worse —
becoming advisory by omission.

Asking everyone everything is a legitimate way to run a questionnaire. The row exists because it is
rarely what someone who just authored conditional topics meant.

**An offer in the accept dialog.** When the reviewed proposal contains a conditional topic and the
feature is off, the accept confirmation carries an **unticked** "Turn conditional topics on now" box.
Ticking it sends `enable: true` alongside the accepted set, and `acceptTopicDraft` merges
`enabled: true` into the settings in the same transaction that writes the topics.

Three details keep the invariant intact:

- The schema field is `z.literal(true)` and is named for the **act** (`enable`), not the state
  (`enabled`). This route can turn conditional topics on and has no way to turn it off, so a caller
  that spread a settings object into an accept body cannot switch routing off for every respondent
  in flight. The `enabled` key remains unsettable through the accept contract, as it was.
- The box starts unticked on every open **and** resets on cancel. Accepting is authoring; going
  live is a separate yes, and a box that remembered a previous yes would turn the feature on for an
  admin who reopened the dialog only to re-read the proposal.
- The accept audit entry records `scopeEnabled` and `enabledByAccept`, because this accept may be
  the moment routing started deciding what respondents are asked — previously only a settings PATCH
  could be that moment, and only that PATCH was audited as such.

The dialog's closing sentence follows the same three cases: already on ("these topics decide what
respondents are asked as soon as you accept"), off with conditional topics ("every topic here would
be asked to everyone until you turn it on"), and off with none ("conditional topics stays off until you
turn it on yourself" — the sentence that used to be shown unconditionally, including, wrongly, to
versions where the feature was already on).

### What the check reads, and how long it stays suppressed (F17.22 Phase 3)

The gate above was also swallowing documents that _do_ say it, in three separate ways.

**It read the wrong 20,000 characters.** The check took the head of the document and nothing else.
Routing pages, guardrail tables, eligibility appendices and "how to use this" notes are very often
at the BACK — and a workbook's Routing sheet flattens last of all — so the check answered "found
nothing" on evidence it never saw. `selectCandidacyExcerpt` (`scope/candidacy-excerpt.ts`) now
composes the same budget instead of slicing it: the head, the tail, and a ~2k window around every
passage that uses routing vocabulary, in document order, joined with a `[…]` elision marker. The
rubric is told the text may be an excerpt and told never to quote across an elision — two distant
spans joined at a seam would otherwise produce a `sourceQuote` that does not exist in the document,
in the one check whose whole value is that its evidence is quoted.

The term list is routing VOCABULARY (`eligib`, `screener`, `guardrail`, `skip logic`, `only if`,
`who answers`, `scoring`, …), deliberately not domain vocabulary: the same instrument shape turns up
in clinical screeners, procurement questionnaires and staff surveys, and a list tuned to one would
silently fail the others. `matchedTerms` is logged, which is what lets an operator tell **"it read
the routing page and still said no"** from **"it never reached the routing page"** — previously
unanswerable.

**The terms are in two tiers, and that is load-bearing.** The budget affords about three windows
(8,000 spare ÷ ~2,100 each), not the eight the window cap suggests. Allocating them
first-come-first-served over one flat list meant a scoring rubric or a "branch office" at character
11,000 could spend the lot and elide the routing appendix at 60% depth — precisely the miss this
module exists to prevent. STRONG terms (`routing`, `only ask`, `skip logic`, `inclusion criteria`,
`eligib`, …) can only be an instruction about who is asked what, and take windows first, wherever
in the document they sit; WEAK terms (`scoring`, `branch`, `facilitator`, `how to use`, …) are real
signals that are also ordinary words, and get what is left. A weak term still lands in
`matchedTerms` whether or not it won a window.

**It read only prose.** A role- or segment-shaped instrument states its routing in its TITLES —
"Section 6 — franchise owners only" — and a screener question ("Which best describes your
organisation?") is the other half of the same statement. Both now travel with the excerpt as the
extracted section titles and question wordings. The rubric treats them as the document's own words
**and keeps its bias**: a title that addresses a kind of respondent is stated routing; a long list
of varied titles is still not.

Counts are not a budget: item counts (120 titles / 300 prompts) are bounded, each item is truncated
(120 / 200 chars), **and** the two lists share an 8,000-character ceiling. Without the ceiling, 300
long prompts could quadruple a prompt that already carries a 20k excerpt — on a check whose whole
constraint is being cheap enough to run on every upload and whose 20-second timeout fail-softs to
_no verdict at all_, landing the failure on exactly the large routing-shaped instruments this is
for. Questions are read through their sections rather than version-wide, because
`AppQuestionSlot.ordinal` is only globally ordered by ingestion's own convention — the Structure
editor counts within a section — and the prompt tells the model these are in document order.

**One failure disabled it forever.** `resolveAutoTriggerPending` treated any prior
`routing_analysis` `AppAiRun` as "already tried" — including one the analyse route itself logged as
`status: 'failed'`. A single provider blip during the first tab visit switched the automation off
for the life of that version, silently, with nothing on screen to say so. Only a **succeeded** run
is conclusive now; failures are counted and tolerated up to two, because "retry until it works"
over a paid model call with a misconfigured provider is a bill, not a recovery. After that the
admin's own button is the way back in — it reports its errors, which the silent auto-run
deliberately does not. Legacy rows are unaffected: `AppAiRun.status` defaults to `succeeded`, so
anything written before failures were recorded still reads as conclusive.

### Proposing during the upload (F17.22 Phase 2)

The candidacy check's verdict used to sit in the database waiting for someone to open the Adaptive
scope tab. On a **streaming** ingest or re-ingest, a `true` verdict now runs the Routing Analyst
immediately, under a `proposing_scope` phase after `checking_scope`, and saves the draft before the
stream closes. The admin is already watching an upload progress stream, so the added time reads as
work rather than as a stall — and an admin who never opens the tab still has a reviewed proposal
waiting when they do.

**Only the streaming routes.** The plain (non-streaming) ingest and re-ingest keep the lazy
tab-visit trigger: there is no job queue in this repo to hand a 180-second run to, and no ordinary
request should be held open for one.

**And only when there is still room for it.** Both streaming routes declare `maxDuration = 300` —
this deployment's ceiling — while the stages are bounded at 300s (extraction), 60s (verify), 90s
(repair), 20s (candidacy) and 180s (the analyst). Those worst cases do not co-occur on a real
upload, but the inline proposal is the one stage that can be skipped without failing anything, so
it checks the elapsed time first (`canProposeDuringIngest`, 90s) and leaves the work to the Topics
tab's auto-trigger when the stream has already spent the budget. Being killed mid-stream is the
failure worth avoiding: the version is already persisted, but the client never sees `done`, so the
upload dialog reports a failed upload for a questionnaire that exists — and the admin retries,
paying for the whole pipeline again.

**It re-checks eligibility before it writes.** The candidacy check deliberately returns its verdict
while _skipping_ persistence when the version stopped being untouched during its call, so a `true`
verdict is not on its own a licence to write. `proposeScopeDuringIngest` re-checks, or the race that
check protects against ends with the ingest upserting over the draft an admin is part-way through
reviewing.

**Fail-soft, absolutely.** `proposeScopeDuringIngest` never throws: a missing agent, a provider
outage, an unusable reply and a thrown query all resolve to "no proposal". An upload that completed
is never reported as failed because an optional proposal could not be made — and the admin can
still press the button on the tab, which reports failures properly, unlike a silent run.

The `done` event carries `conditionalTopicsProposal: { topicCount, conditionalCount }` when a proposal
was made, and a second `proposing_scope` phase message names the counts in prose. Nothing is live:
it is a pending draft, and `conditionalTopics.enabled` is untouched, exactly as with a button-triggered
run. The **re-ingest dialog** reports it on its result screen — that dialog is the only place the
admin is still standing when the run finishes, since the upload dialog navigates to the new draft.

**One implementation, two callers.** The analyst run moved into
`app/api/v1/app/questionnaires/_lib/routing-analysis.ts` — `dispatchRoutingAnalysis` (which records
the **failed** `AppAiRun` on both failure paths) and `persistRoutingAnalysis` (which saves the
draft and records the **succeeded** one). The SSE route keeps its phase events and owns nothing
else. That split is not tidiness: the `routing_analysis` run row is the "already tried" signal the
auto-trigger reads, so a second copy that forgot to record one would re-propose on every tab visit,
and one that recorded the wrong status would disable the automation for the life of the version.
The run's `detail.trigger` (`admin` | `ingest`) and the audit entry's matching field are what let
"where did these topics come from" be answered afterwards.

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

Every other Conditional Topics surface is about **intent**: the criteria you wrote, the limits you set,
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

`validateConditionalTopics` runs on read (the Topics page, the launch checklist) rather than blocking
saves — an admin mid-edit routinely has an incoherent set, and a surface that refuses the save is a
surface they fight.

The check that matters is **`orphaned_questions`**: with scope active, a question belonging to no
topic can never be asked, and nothing else in the system would report it. It is an `error` when the
feature is on and a `warning` when it is off — the second being exactly what an admin needs to see
_before_ flipping the switch.

### `light_depth_on_always_topic` — the second way to delete a question silently (F17.23)

`membersAtDepth` applies depth to **every** phase, not only `conditional`. So `light` on an
`opening`, `core` or `closing` topic does not sample it — it drops every member past
`LIGHT_DEPTH_MEMBER_COUNT` from an interview everyone gets, and nothing else reports it. That is the
same harm as an orphaned question arriving by a different route, so it carries the same severity
rule: `error` once the feature is on, `warning` before.

On the **opening** it is worse than a deletion, and the message says so separately: the opening is
the evidence the whole plan is decided from, so sampling it decides the interview from half the
answers. This was not hypothetical — the Routing Analyst proposed exactly this on two real
instruments before F17.23.

Two things keep it from being noise. It counts **per kind**, because depth trims `questionKeys` and
`dataSlotKeys` separately; and it stays silent when the topic is small enough that `light` and
`full` are the same run, because `membersAtDepth` early-returns there and the setting changed
nothing.

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
| `rule_names_always_topic`  | warning                    | The rule's target is `core` / `opening` / `closing`, so the rule changes nothing                |

**A rule aimed at an always-run topic does nothing at all.** `applyGuardrails` seats and vetoes
within the _conditional_ set, and `resolveScope` puts every other phase in scope regardless — so
"never include the audit questions for a non-licence-holder" is inert the moment `audit` is a `core`
topic. It is the same no-op as `always_topic_named_as_choice`, reached from the other direction, and
it is reported separately because the fix differs: the author either meant a different topic or meant
to make this one conditional. On the map the rule node carries a **No effect** badge.

**The veto case is the one worth an error.** Absence is what `not_exists` matches on, so an
ungathered slot does not make the rule inert — it makes it fire for everybody. An author who wrote
"never score them on AI readiness when they never named an outcome" gets that applied to every
respondent, and every plan it produces is plausible. Nothing downstream would ever report it.

All three are silent when the version has no opening topic at all: `no_opening_topic` is the finding
to fix first, and one reachability warning per rule on top of it buries the cause.

### Comparability — what routing does to a score (F17.15)

Scoring combines answers into a scale; Conditional Topics decides which of them get asked. Together they
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

### A follow-up limit that cannot bind

Two ways to ration the opening's follow-ups and change nothing, neither visible from the tab it is
set on. `opening_probe_limit_inert` fires when no opening topic contains a data slot that exists —
the allowance rations conversational follow-ups, so an opening built from form questions is not
rationed at all. `opening_probe_limit_moot` fires when `maxDataSlotAttempts` is 1, which is the
**default**: one ask, no follow-up ever, so there is nothing for the allowance to bound. That knob
lives on the Settings tab, which is precisely why the author cannot see it from here — the Topics
route loads it (`loadMaxDataSlotAttempts`) for no other reason.

---

## Scope evaluation (F17.21)

`validateConditionalTopics` (above) and the cost model answer "is this configuration well-formed and
what does it cost" — both mechanical, both free. Neither answers "is this a **good** routing
design toward the module's own goal" — minimize respondent burden while never silently dropping a
topic that genuinely applies (the [one invariant](#the-one-invariant): hard rules always win, "when
in doubt, ask", exclude-beats-include). That is a judgement call, not a rule, so it is a second
judge panel — sibling to the design-evaluation panel (F5.1–F5.3) that reviews question structure,
but reading the scope config instead.

**Structural only, v1.** The four judges read the authored topics, hard rules, planner
instructions, and budget — the same inputs `validateConditionalTopics` and the cost model read. They do
not read live session data or the routing-analytics engine (F17.16); a later phase could layer that
signal in, but v1 answers "is this well-designed" from the config alone.

| Dimension             | Judges                                                                                                                                  | Does NOT re-derive                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `criteria_quality`    | Is each conditional topic's criteria specific and observable from an opening conversation? Do two topics' criteria overlap or conflict? | `orphaned_questions` / duplicate membership                                    |
| `rule_integrity`      | Internal rule conflicts, redundant rules, a rule that excludes on weak/ambiguous evidence ("when in doubt, ask" violations)             | `rule_slot_unreachable` / `rule_veto_always_fires` / `rule_names_always_topic` |
| `budget_realism`      | Does the budget leave realistic room for topics that matter; is `maxConditionalTopics` too tight or too loose for the topic mix         | the cost arithmetic itself — judges are fed the pre-computed numbers           |
| `coverage_and_burden` | Topics with no realistic path to selection (a blind spot), unconditional bloat, overall burden vs. budget                               | `orphaned_questions`                                                           |

Each judge is blind to the others, same as the design-evaluation panel's judges — and unlike that
panel, **there is no reconcile step**. The four dimensions target different fields of different
objects (a topic's criteria text, the rules array, the settings blob), so the collision case the
design-evaluation reconciler exists for — two judges rewriting the same question prompt
differently — mostly cannot occur here. A deliberate v1 cut, not an oversight.

### Findings and the apply flow

A finding names its subject with a `targetKey`: `topic:<key>` | `rule:<id>` | `settings`. Most also
carry a machine-applicable `proposedEdit` — one of eight ops, each writing to exactly one field a
finding could plausibly ask for:

| Op                                       | Touches                                                              | Writer                                  |
| ---------------------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `edit_topic_criteria`                    | `AppQuestionnaireTopic.criteria`                                     | single-row update by `(versionId, key)` |
| `edit_topic_depth`                       | `AppQuestionnaireTopic.depth`                                        | single-row update                       |
| `add_rule` / `edit_rule` / `delete_rule` | `AppQuestionnaireConfig.conditionalTopics.rules[]`                   | `patchConditionalTopicsSettings` merge  |
| `adjust_budget`                          | `sessionBudgetSeconds` / `maxOpeningProbes` / `maxConditionalTopics` | `patchConditionalTopicsSettings`        |
| `edit_planner_instructions`              | `plannerInstructions`                                                | `patchConditionalTopicsSettings`        |
| `add_fallback_topic`                     | `fallbackTopicKeys[]`                                                | `patchConditionalTopicsSettings`        |

There is no `add_topic` / `delete_topic` — every op edits something that already exists, keeping
one-click-apply blast radius small. A finding that thinks a topic shouldn't exist at all stays
prose-only, the same as an off-mission finding in the design-evaluation panel.

The review queue (accept / decline / edit / apply) and staleness derivation mirror the
design-evaluation panel's own machinery: applying re-checks the finding against the live config,
forks a launched version via `forkVersionIfLaunched` exactly like every other authoring write on
this tab, and staleness is derived at read time by diffing the run's `scopeSnapshot` against the
live structure rather than stored as a flag that would rot.

### Where it lives

A sibling module, `lib/app/questionnaire/scope-evaluation/`, not an extension of
`lib/app/questionnaire/evaluation/` (F5.1–F5.3): that module's `EVALUATION_DIMENSIONS` tuple and
`ProposedEdit` union are closed, compile-time-locked to question/section/goal/audience vocabulary.
The two modules share only generic leaf vocabulary (`FindingSeverity`, `FindingReviewStatus`,
`FindingApplicability`) and the fan-out/persist/apply _pattern_ — not a type.

The card lives on the Topics tab (`ScopeEvaluationCard`, alongside the Routing Analyst and plan
preview) as an ephemeral preview — "Run evaluation" writes nothing — with a "View past runs" link
into a persisted run-history + review-queue surface at `.../topics/evaluations`, the same
ephemeral-preview-then-persisted-review split as the design-evaluation panel's own F5.1 → F5.2/F5.3
progression, done here in two PRs instead of three since the surface is small enough that
splitting run-history from apply would be an artificial seam.

### In the Questionnaire Pack

The latest run's judge scores and findings nest inside the pack's existing `conditionalTopics` section
as `PackConditionalTopics.evaluation` — not an eighth top-level section — because it is a judgement
_about_ the routing design printed just above it, not a separate subject. `evaluation.hasRun: false`
still renders (the same "state a fact rather than omit the section" choice the design-evaluation
appendix makes) so a pack downloaded before the panel has ever run says so explicitly rather than
silently having nothing there. No new `PackInclude` flag: it rides along with `conditionalTopics`,
which already defaults off.

---

## Files

| Path                                                                                                   | What                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/app/questionnaire/scope/types.ts`                                                                 | Vocabulary, settings, plan shape, narrowers. A **leaf** — it carries its own `narrowToEnum` copy so `types.ts` can hold an `ConditionalTopicsSettings` without a runtime import cycle                                                                             |
| `lib/app/questionnaire/scope/resolve.ts`                                                               | The pure filter                                                                                                                                                                                                                                                   |
| `lib/app/questionnaire/scope/rules.ts`                                                                 | Hard-rule evaluator                                                                                                                                                                                                                                               |
| `lib/app/questionnaire/scope/guardrails.ts`                                                            | Cap, fallback, the time fit, check topic                                                                                                                                                                                                                          |
| `lib/app/questionnaire/scope/budget.ts`                                                                | What an interview costs in seconds — per-type pricing, per-topic cost at both depths, the floor and the allowance                                                                                                                                                 |
| `lib/app/questionnaire/scope/planner.ts`                                                               | The model call; never throws                                                                                                                                                                                                                                      |
| `lib/app/questionnaire/scope/probe.ts`                                                                 | The opening's follow-up counter (G03) — pure, so the orchestrator can import it                                                                                                                                                                                   |
| `lib/app/questionnaire/scope/routability.ts`                                                           | "Could the plan already be decided?" — the check that decides whether a probe is worth spending; returns null on every failure                                                                                                                                    |
| `lib/app/questionnaire/scope/amendment.ts`                                                             | Cue gate, label match, plan mutation (F17.6) — pure                                                                                                                                                                                                               |
| `lib/app/questionnaire/scope/analysis-schema.ts`                                                       | The Routing Analyst's output contract                                                                                                                                                                                                                             |
| `lib/app/questionnaire/scope/analysis-prompt.ts`                                                       | Its rubric — mostly about quoting versus inferring                                                                                                                                                                                                                |
| `lib/app/questionnaire/capabilities/analyse-routing.ts`                                                | The analyst capability                                                                                                                                                                                                                                            |
| `app/api/v1/app/questionnaires/_lib/routing-analysis.ts`                                               | Running the analyst — dispatch (records the failed `AppAiRun`) and persist (records the succeeded one, saves the draft, audits the trigger). Shared by the SSE route and the streaming ingest, so the run bookkeeping the auto-trigger reads has one home         |
| `lib/app/questionnaire/scope/candidacy-excerpt.ts`                                                     | What the ingestion-time check reads — head + tail + a window around every passage using routing vocabulary, elisions marked. Pure                                                                                                                                 |
| `lib/app/questionnaire/scope/candidacy-prompt.ts` · `candidacy-schema.ts`                              | The check's rubric (quote-preferring, excerpt-aware) and its output contract                                                                                                                                                                                      |
| `app/api/v1/app/questionnaires/_lib/scope-candidacy.ts`                                                | The check's DB seam: eligibility, the excerpt + extracted structure, the cached verdict, and `resolveAutoTriggerPending`                                                                                                                                          |
| `lib/app/questionnaire/scope/seed.ts`                                                                  | One topic per section, pure                                                                                                                                                                                                                                       |
| `lib/app/questionnaire/scope/validate.ts`                                                              | Coherence findings, plus `uncoveredQuestionKeys` / `uncoveredDataSlotKeys` — shared with the payload's `coverage` block so the header and the issue list cannot disagree                                                                                          |
| `lib/app/questionnaire/scope/comparability.ts`                                                         | What routing does to a scoring scale (F17.15) — which scales it can narrow, and which no plan can ever cover                                                                                                                                                      |
| `lib/app/questionnaire/scope/graph.ts`                                                                 | The routing map's graph (F17.18) — pure, laid out, and carrying no React Flow import                                                                                                                                                                              |
| `lib/app/questionnaire/scope/criteria-format.ts`                                                       | Reads an author's criteria text as the list it already is — recovery only, never rewriting                                                                                                                                                                        |
| `lib/app/questionnaire/analytics/routing.ts`                                                           | Routing quality (F17.16) — what the planner actually did across a version's interviews, and the findings the counts support                                                                                                                                       |
| `app/api/v1/app/questionnaires/_lib/session-scope.ts`                                                  | The DB seam                                                                                                                                                                                                                                                       |
| `app/api/v1/app/questionnaires/_lib/seed-topics.ts`                                                    | Seeding + reconcile-after-rewrite                                                                                                                                                                                                                                 |
| `app/api/v1/app/questionnaire-sessions/_lib/plan-scope.ts`                                             | The post-turn trigger                                                                                                                                                                                                                                             |
| `app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/route.ts`                                    | GET / PUT / PATCH                                                                                                                                                                                                                                                 |
| `.../topics/preview/route.ts`                                                                          | The plan dry-run (F17.14) — the planner over a synthetic opening; writes nothing                                                                                                                                                                                  |
| `.../analytics/routing/route.ts`                                                                       | Routing quality (F17.16) — per-topic selection / exclusion / amendment counts over the window                                                                                                                                                                     |
| `app/api/v1/app/questionnaires/_lib/plan-inputs.ts`                                                    | The shared version-side planner inputs, so the dry-run and the interview price the instrument identically                                                                                                                                                         |
| `.../topics/analyse/stream/route.ts` · `.../topics/draft/route.ts`                                     | Run the analyst (SSE) · accept or discard its proposal                                                                                                                                                                                                            |
| `app/api/v1/app/questionnaire-sessions/_lib/amend-plan.ts`                                             | The amendment trigger                                                                                                                                                                                                                                             |
| `components/admin/questionnaires/topics/**`                                                            | The Conditional topics tab: explainer, settings, rules, topic editor, analyst review, and the routing map's dialog / canvas / nodes                                                                                                                               |
| `lib/app/questionnaire/scope-evaluation/**`                                                            | Scope evaluation (F17.21) — dimension registry, judge schema/prompt, structure DTO + Zod, fail-soft fan-out (`run-panel.ts`), by-target grouping, and `describe-op.ts`'s plain-English rendering of a `ScopeProposedEdit`, shared by the review card and the pack |
| `lib/app/questionnaire/scope/rule-format.ts`                                                           | `describeScopeRule` — promoted out of the pack builder in F17.21 Phase A so the pack and the scope-evaluation judge prompt share one rule-sentence implementation                                                                                                 |
| `lib/app/questionnaire/capabilities/evaluate-scope.ts`                                                 | The scope-evaluation judge-dispatch capability                                                                                                                                                                                                                    |
| `prisma/seeds/app-questionnaire/091-scope-evaluation-judges.ts` · `092-scope-evaluation-capability.ts` | Seeds the four judge agents and the capability row                                                                                                                                                                                                                |
| `app/api/v1/app/questionnaires/_lib/scope-evaluation-*.ts`                                             | The DB seam: structure loader, run persist/list/detail, staleness derivation, target resolution, apply engine — mirrors the `_lib/evaluation-*.ts` split                                                                                                          |
| `.../topics/evaluate-preview/route.ts`                                                                 | Ephemeral panel run — writes nothing                                                                                                                                                                                                                              |
| `.../topics/evaluations/**`                                                                            | Persisted run create/list/detail/retry and the finding review/apply routes                                                                                                                                                                                        |
| `components/admin/questionnaires/topics/scope-evaluation-*.tsx` · `scope-finding-review-card.tsx`      | The preview card, the run-history table, the run-detail view, and the finding review card                                                                                                                                                                         |
| `app/admin/questionnaires/[id]/v/[vid]/topics/evaluations/**`                                          | Run history and run detail pages                                                                                                                                                                                                                                  |

## Try it — the plan preview (F17.14)

**Every other check on this tab is structural.** `validateConditionalTopics` says the configuration is
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

## The routing map (F17.18)

Every other surface on this tab states the routing in **prose or in lists** — a rules editor, a settings
card numbered by the order the runtime applies it, a topic list. All of them are correct, and none of them
is a picture. "Routing map" is: a zoomable canvas, opened from a button at the top of the tab, drawn
entirely from the payload the tab already holds.

### There are no topic-to-topic edges, because there is no such mechanism

The obvious thing to draw — arrows between topics — would be a lie. Topics do not flow into one another;
a topic is selected or it is not. What Conditional Topics actually is, is a decision pipeline, and the
pipeline is what is drawn:

```
start ──> opening topics ──> hard rules ──────────────────────────┐
      │                  └─> planner ──> guardrails ──> conditional topics
      └──────────────────────────────────> always asked (core + closing)
```

**The geometry is the argument.** A rule edge runs straight from the rule to its topic, skipping over the
planner and the guardrails — because `applyGuardrails` seats rule includes _before_ the cap and never
truncates them. The misreading this prevents is the one the settings card's numbering already fights: a
cap read as a request the model tries to honour, rather than a limit applied to its answer. On the map it
is a shape rather than a sentence.

The always-asked band hangs off `start` and bypasses everything, which is the same claim about the other
end: the planner touches the `conditional` phase and nothing else.

### Structural, never predictive

No fills exist at authoring time, so **no rule can be evaluated and no plan can be known**. Every rule
draws its edge; the guardrails draw a candidate edge to every conditional topic. `evaluateScopeRules` and
`plannerCandidates` are deliberately not called — both need a session's fills, and a map that pretended to
have them would be a preview that lies, quietly, in the one direction an author cannot check. The dry-run
card above it is the surface that answers "what would this actually do", and the dialog's own subtitle
points at it.

### The one thing the structure can settle

Where a rule reads its evidence from. That is a fact about the topic set, not about a respondent, so it is
drawn — and it is classified **exactly as `validateConditionalTopics` classifies it**: opening, `core`, or
neither. A solid edge from the opening topic that gathers the slot; an amber dashed edge labelled _timing
not guaranteed_ from a `core` topic; and from an explicit **"Not gathered in the opening"** node when
nothing reachable gathers it at all.

That last node is the point of the whole treatment. `rule_veto_always_fires` is the sharpest finding this
feature has — a veto reading an ungathered slot fires for **every** respondent, and every plan it produces
looks entirely reasonable — and it is currently one warning in a list. On the map the rule visibly hangs
off nothing.

The two computations are independent (the validator words a warning, the builder picks an edge), which is
exactly the pair that drifts silently, so `graph.test.ts` asserts they agree across all four cases.

### The always-asked band can collapse, but does not start that way

Ingest seeds one `core` topic per extracted section, so fifteen-plus always-asked topics is the ordinary
first sight of a version. The band therefore has a priced head node (`Always asked — 15 topics · 4m 26s`)
and a toggle that puts every topic behind it.

The toggle is **on by default**, which is a reversal. It shipped off, on the reasoning that fifteen
individually drawn topics crowd out the conditional band — the only part of the picture any decision is
taken about — and while the band was drawn as a wrapped row that was simply true. Stacked in a column of
its own, clear of every other stage's `x`, it costs the rest of the map nothing, and the first sight of a
routing map should be the whole interview rather than a summary of a third of it. The toggle stays for
the reader who wants the pipeline on its own.

Its id is `always::band`, with two colons, and that is not a typo. Topic nodes are `always:<key>` and
`topicKeySchema` permits the key `band`, so a single colon let a legitimately-named topic land on the
canvas under the head's own id — a duplicate node, a self-edge, and every click on that topic resolving
to the band head. Topic keys are `^[a-z0-9_]+$`, so the second colon puts the head somewhere no key can
reach.

The head node stays on the canvas in **both** states, and that is load-bearing rather than tidy: it is the
band's only anchor. `start` points at it rather than at fifteen topics, and a weak-evidence edge from a
`core` topic falls back to it while the band is collapsed. React Flow silently drops an edge whose
endpoint is missing, so a head that came and went would take those edges with it — which is why
`graph.test.ts` asserts no edge ever names a node that is not present.

### On-screen copy is plain English, never the code's vocabulary

The map and the settings tab used to say a rule **seats** a topic, that a plan **seats at most 3**, that
nothing was **seated**, that a rule **vetoes**, that a topic is **out of scope**, that a check is
**deterministic**, and that time is left for **routed** topics. Every one of those is a word from the
implementation — `guardrails.ts` really does have a `seat()` — and none of them is a word an admin has
ever been taught. A reader who has to decode the label cannot check the thing the label describes, which
defeats the point of a surface whose entire job is to be checkable.

The replacements, which are the vocabulary to keep using:

| Was                | Is                                      |
| ------------------ | --------------------------------------- |
| seats / is seated  | adds / is included / is asked           |
| nothing was seated | nothing was chosen                      |
| vetoes / vetoed    | blocks / blocked                        |
| the cap            | the limit on how many topics            |
| routed topics      | the topics the agent chooses            |
| out of scope       | not part of this respondent's interview |
| deterministic      | applied in code, not asked of the AI    |
| the instrument     | the questionnaire                       |
| the pipeline       | the flow above (on the map)             |

And the second pass (F17.27), over card titles, buttons and ⓘ popover headings:

| Was                       | Is                                     |
| ------------------------- | -------------------------------------- |
| Routing Analyst           | Suggest topics from your document      |
| Routing map               | Decision flow                          |
| What routing actually did | What happened in real interviews       |
| Scope evaluation(s)       | AI review of this setup / Past reviews |
| Run the planner           | Preview the decision                   |
| Phase                     | When it runs                           |
| Depth                     | How much of it                         |
| Criteria (popover title)  | When this applies                      |
| Fallback topics           | Ask these instead                      |
| Confidence floor / needed | How sure the AI must be                |
| Planner instructions      | Extra guidance                         |
| Topic limit               | How many topics                        |
| Blind-spot preference     | Which topic to sample                  |
| Session length budget     | How long an interview may take         |
| Ration follow-ups         | Limit follow-up questions              |

**One vocabulary collision fixed deliberately.** The settings said "Most _conditional_ topics per
interview" while the phase chip said "Ask when it fits" — one concept, two names. `conditional` is
the word the product teaches everywhere else, so the chip now agrees with it; the phase _selector_
keeps "Conditional — ask when it fits", because the selector is where the word is taught. Renaming
`conditional` to "optional" was rejected: it would desync from the docs, the issue messages and the
report vocabulary at once.

Domain words an admin _is_ taught by the UI stay: **topic**, **data slot**, **opening**, **conditional**,
**hard rule**, **guardrails**, **blind-spot check**, **Full / Light depth**. The test is not whether a
word is technical, it is whether the product ever teaches it — `Light depth` is a labelled control on
the topic editor, `seated` was never anywhere but the source.

### Every badge is explained where it is read

`Fallback` and `Preferred check` are the system's own vocabulary for guardrail mechanics an author met
once, in a settings field, possibly weeks ago. Two words on a node cannot carry that, and for a while
nothing anywhere on the map said what they did — a reader could see that `Management` was a fallback and
still have no way to learn what being one costs or buys.

Both the pill and its sentence now come from one table, `SCOPE_BADGES` in `graph.ts`, and the detail
panel renders the pill in the same shape and colour the node drew it in — literally, from the same
`BADGE_TONES` table, because two copies of a colour map drift while the text stays identical, which is
the one mismatch that makes a reader doubt they clicked the right node. So a reader is not matching two
words by memory. Building them together is what makes the guarantee cheap: `graph.test.ts` asserts that
every badge on every node the builder can produce has a note beside it, in the same order, so a badge
cannot reach the canvas unexplained.

The meanings are written as consequences rather than definitions — a fallback is "used only when the
decision chooses nothing at all", not "a fallback topic" — because the question a reader has in front of
this map is always what the tag _does to a respondent_.

### The layout is size-aware and lane-based, because a fixed grid cannot be

The first cut laid the map on a fixed grid — one column every 300 units, one row every 120, every column
centred on y = 0. Each of those three decisions produced a different defect.

**A 300 pitch** leaves 64 units of gutter beside a 236-wide node, which at the zoom `fitView` picks for a
twelve-topic column reads as boxes touching. The pitch is now written as the node's own width plus the
gutter, and the gutter is half a node wide.

**A fixed row pitch** has to be set for the tallest node in the graph, so a two-line label carrying two
badges either overlaps its neighbour or forces every single-line node to sit in a pool of dead space.
`graph.ts` now estimates each node's rendered height from what it says — label lines, sublabel lines,
badge rows — and stacks each column from those heights with a constant gap between bottom edge and top
edge. The constants are read off `routing-map-node.tsx`, and the node's width travels the other way: the
renderer takes it from `ROUTING_MAP_NODE_WIDTH` rather than a Tailwind class, because the column pitch is
derived from it and a node that renders wider than the layout believes closes the gutter it left.
Estimated rather than measured because the graph is built before React Flow has seen a node, and React
Flow's own measurement arrives far too late to position anything with. A few pixels out is absorbed by
the gap; height-blind is not absorbed by anything.

**Every column on one centre line** was the worst of the three, and it did not merely look flat. A
left-to-right graph draws its edges as horizontal runs, so six columns on one line puts every run in the
same horizontal band: the hard rule's edge to its conditional topic was drawn straight through the
planner and the guardrails, and a reader could not tell an edge that stops at a node from one that passes
behind it. Each column now sits on its own **lane**. The ±56 along the spine is the small job — it stops
two adjacent columns sharing a run. The hard rules get a much larger offset, and that one carries meaning
rather than clearance: a rule **bypasses** the planner and the guardrails, which is exactly where
`applyGuardrails` seats it, so it is drawn as the bypass lane it is, running underneath the stage it goes
around.

**Every edge runs left to right, and the band is what nearly broke that.** React Flow leaves each node's
source handle on the right and its target handle on the left, so two nodes sharing an `x` are joined by a
path that leaves the right side, doubles back over both boxes and re-enters from the left — a rendering
fault to look at, not a relationship. The band used to start one column right of where it does now, which
put its expanded topics in the **rule** column, and the weak-evidence edge from a `core` topic to the rule
reading its slot then ran inside a single column. That edge is the "timing not guaranteed" case: the
single most important thing on this map, drawn worst.

The band now hangs beneath the pipeline's first two columns instead of its second and third, which puts
head → topic and topic → rule back on left-to-right runs. The one edge that cannot be — `start` → head,
now directly below it — is why the head is the only node on the map whose inbound handle is on the
**top**, and drawing it as a vertical drop is what the band was always described as doing anyway.
`graph.test.ts` asserts the invariant over the whole graph rather than over that one edge, because the way
it was introduced was a layout decision taken for unrelated reasons.

### A node's title is never truncated

The title used to clamp at two lines, which drew a rule node as `Commercial outcome named was never…`.
An ellipsis in a title is worse than a tall node: a truncated rule sentence reads as a _different rule_.
`was never…` could be `was never answered`, and the operator is the whole of what decides whether that
rule fires for one respondent or for every one of them. Titles now wrap as far as they need, and
`estimateNodeHeight` counts the lines, so the extra height is already in the stacking.

The sublabel still stops, at three lines. It is a summary, its full text is one click away in the detail
panel, and it is the one field an author can make arbitrarily long by naming a topic in a sentence.

### The always-asked band is one column, not a wrapped row

The band's expanded topics stack in a single column one step right of the head, exactly as the conditional
topics stack one step right of the guardrails. An earlier cut wrapped them left-to-right across three
columns, reasoning that a list should not be drawn as a stage of the pipeline. It drew a picture that
lied: every topic hangs off the one head node, and **a fan-out of N edges can only be drawn without
running through a box if every target has a horizontal lane to itself** — wrapped, the head's edge to the
third topic was drawn straight through the first two.

What keeps the band from reading as a stage is what it is drawn in — dashed borders, muted fill, and
`ALWAYS_BAND_GAP` of clear air below the spine — not which way it wraps. Keeping it inside one `x` also
means it only has to clear the two short columns it hangs beneath, never the twelve-topic conditional
column away to the right; hanging it below _that_ put a screen of dead canvas through the middle of the
picture, which `fitView` then has to zoom out to include, shrinking every label on the map to buy
nothing. `graph.test.ts` asserts the strong form: no band node's box ever intersects a pipeline node's.

### Read-only, with one way back

Clicking a node opens its detail: what it is, what decides it, where its duration comes from, what each
of its **tags** means, and — for a conditional topic — the author's criteria, which the node never shows.
A topic
node also offers **"Edit this topic"**, which closes the map and expands that row in the topic list.

The dialog closes first on purpose: the row is behind the overlay, so leaving the map open would read as
the button having done nothing. The request carries a **nonce** beside the key, because asking for the same
topic twice must still move the list — a bare key is unchanged state the second time and the effect never
re-fires. And `TopicListEditor` **clears its filter** before expanding, since a row the current filter
hides has nothing to open; honouring the request beats preserving a view preference.

Nothing is authored on the canvas. A second editor beside the topic list is a second thing that can
disagree with it, and the map has no mutation of its own worth that risk.

### A duration with no provenance is a duration nobody believes

The panel used to print two rows — `Full depth 1m 17s`, `Light depth 16s` — and nothing else. Those are
correct figures and they were still the wrong surface, because none of the three questions an author
actually has could be answered from them: what is being counted, where the number came from, and whether
it describes the **chat** they are going to run. The reasonable reading of an unexplained duration on a
routing screen is that it was measured, and it was not.

So the panel shows the arithmetic instead (`ScopeNodeTiming`, built in `scope/graph.ts`):

|                                             |                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **One line per rate**                       | `4 × Likert @ 8s → 32s`, `1 × Free text @ 45s → 45s`. Grouped by rate rather than by type, so a 6-row matrix and a 3-row matrix stay two lines instead of averaging into a rate that prices neither. The column adds up. |
| **The authored depth is marked**            | One of the two figures is what this topic actually costs; the other is context. Two equal numbers is two questions, one marked number is an answer.                                                                      |
| **The light sample is named**               | Not just "16s" but _which_ members — computed through the same exported `membersAtDepth` the interview resolves with, so the named members and the priced members cannot be different sets.                              |
| **The headline still comes from `costs`**   | The server prices topics and the planner drops them by that price; a second implementation in the browser is exactly the drift `scope/budget.ts` warns about. The breakdown is derived from the same per-item seconds.   |
| **Missing members are counted, not hidden** | A member naming a deleted question is charged nothing, and the panel says how many. Silently short arithmetic is worse than none.                                                                                        |

**The block is collapsed by default.** The arithmetic is wanted once; the figures are wanted every
time. Closed, the section is two readings (`1m 17s full · 16s light`, the authored one marked), a
one-line caveat and a chevron; opening it swaps the readings for the fuller cards rather than
repeating them underneath, so the disclosure reads as a zoom into the same thing rather than as a
second answer. Open, it had grown taller than everything else in the panel put together.

**The caveat is stated in the panel, not behind the ⓘ — and not behind the chevron either.** The estimate is the respondent's _answering_
time, item by item. The interview is a conversation: the agent's turns, its follow-ups, its re-asks and
any back-and-forth are not counted, so a real chat runs longer — and an author who reads the figure as a
stopwatch will set a session budget that cuts their instrument in half. That sentence sits under the
figures at all times; the ⓘ carries the longer version, including the point that this is nonetheless the
arithmetic `applyGuardrails` fits the plan with, which is what makes the relative weights worth reading.

This is why `TopicQuestionRef` and `TopicDataSlotRef` carry `weight`. Without it the panel could show the
light _duration_ but would have to guess at the light _members_, and a named set that disagreed with the
number beside it is the one failure this whole treatment exists to avoid.

### The criteria are a list, and it is drawn as one

A conditional topic's `criteria` is free text, but authors and the Routing Analyst both converge on the
same shape — a lead-in sentence, then one line per signal, usually naming the signal and how much it
counts for. Rendered as one grey block, that structure is invisible and every reader re-derives it by eye.

`scope/criteria-format.ts` recovers it: prose blocks, list items, and per-item `term` / `priority`. It
**recovers, never rewrites** — every character reaches the screen, and the only things moved are the
bullet marker (which becomes the bullet the renderer draws) and the priority marker (which becomes a chip
beside the line it was already describing). Text it cannot read falls through as a verbatim block with its
line breaks intact, which is exactly how the old panel rendered everything.

The term split is deliberately conservative: dashes only (never a colon — `they said something like:` is
not a label), capped at 48 characters and 7 words, and refused outright if the fragment ends a sentence or
leaves nothing after it. A wrongly-split term bolds a fragment and reads as a typo, so the failure mode is
always "no term", never "the wrong term".

### Why a modal rather than a tab

The workspace sub-nav already carries fifteen tabs, and a sixteenth for a **read-only view of another
tab's data** would say the map is a peer of the thing it depicts. A near-full-screen dialog says the truer
thing and gives a canvas the room it needs. There is no fetch, no route and no stored layout behind it:
the map is a pure function of `TopicsPayload`, so it cannot drift from the settings above it — and the
dialog is `key`-remounted on the payload so a stale graph never sits behind the button after a save.

### Three overlays, and why they are not part of the graph (F17.29)

The map draws what a version _can_ do, from its settings alone. That is what makes it trustworthy —
a pure function of the tab above it, unable to drift, never predicting. Three facts from elsewhere
answer questions the structure raises but cannot settle, and each is a toggle rather than part of
the picture:

| Overlay                    | Source                      | What it shows                                                      |
| -------------------------- | --------------------------- | ------------------------------------------------------------------ |
| **Last try-it run**        | the plan preview (F17.14)   | what that run asked, and what it chose and then lost to a limit    |
| **How often it is chosen** | routing analytics (F17.16)  | each topic's real selection rate, with the sample size beside it   |
| **Problems**               | `validateConditionalTopics` | each finding pinned to the topic it names, instead of listed above |

`annotateScopeGraph` lives in its own module and takes a built graph, returning a **new** one.
Keeping it out of `graph.ts` is deliberate: that module's invariant is _structural, never
predictive_, and a layer mixing a session's outcome into the structure would quietly end it. The
base map is the same object with every overlay off, so switching one off restores exactly the
picture that was there before.

**The state worth having.** A topic the agent proposed and a guardrail then took back looks
identical, on the plan alone, to one the agent never wanted. `proposedKeys` beside the plan is what
tells them apart, and _"Taken back on the last run"_ is the only reason this overlay is worth
building.

**A rate is a fact; whether it is a problem is a judgement.** A topic that never fires may be a
rare-case safety net working exactly as designed, so the badge states the share and the sample size
and stops — the same restraint `RoutingFinding` takes.

**A toggle is offered only when it has something to say.** An overlay that switches on nothing reads
as "it found nothing", when in fact nobody has pressed **Try it** yet, or the version has no
interviews behind it. `availableOverlays` decides that, and the dry-run and analytics data are
handed up by the two cards that already own them rather than fetched again — a map that re-fetched
could show a number the card beside it disagrees with.

## The authoring surface

### The status header owns the switch (F17.25)

The stack is ordered by the runtime pipeline, not by the authoring job, so the master switch used
to sit in the header of the tenth card — the last place someone asking "is this even on?" would
look. `ScopeStatusHeader` sits above everything and answers both arriving questions: whether it is
on (with a sentence saying what that _means_ — "Off — every respondent is asked the whole
questionnaire"), and whether it is ready (topics, conditionals, questions in no topic, the
always-asked cost, the time limit).

**The switch is controlled by the server's value, never a local draft.** That is what makes a
declined fork correct: nothing was written, so the next render puts the switch back rather than
leaving it in the clicked position describing a version that never existed.

**Single-writer discipline is enforced in three places**, and all three matter. `enabled` is gone
from the settings card's control, from its remount key, and from the panel's enumerated PATCH body.
Left in the key, a header toggle remounts the card and eats unsaved settings work. Left in the
body, the card's stale draft re-writes whatever the header just set — the classic two-writer race,
resolved by whoever saved last.

`ScopeIssueStrip` is the summary half of the two-level pattern `config-conflicts.tsx` established;
`ScopeIssues` remains the full read, moved down beside the topic rows it is about. Both render the
same `validateConditionalTopics` output, so they cannot disagree. Rows are **buttons, not anchors** —
`ScopeIssue` carries no `sectionId`, and what fixes a finding is a topic row whose DOM id is a
client-side detail — and a topic-scoped row reuses the routing map's existing focus handoff rather
than growing a second mechanism that behaves almost the same.

### The switch is mirrored on the Settings tab (F17.28)

`enabled` is editable in two places now: the status header above, and an **Conditional topics** group
on the workspace's Settings tab. The reason is the header's own question — "is this even on?" —
asked from the other end. An admin auditing how a version behaves at run time reads the Settings
tab, and the one switch deciding whether half the instrument gets asked was the only run-time
switch not on it.

**Only the switch is mirrored.** Topics, criteria, the budget and the planner's settings stay here,
where the surface that explains them is. The Settings group carries the switch, a sentence saying
what its current position means, an ⓘ that says what the feature is for, and a link back to this
tab.

**This does not reopen the two-writer race the section above closed.** That race was between two
controls in one render, decided by whichever rendered last. These are two tabs, each seeded and
resynced from the server's value, and the Settings tab sends `conditionalTopics` **only when its own
switch differs from the config it loaded**. The PATCH is partial by contract — an omitted key
leaves the stored value alone — so a Settings tab opened before someone flipped the switch here
saves everything else it holds and leaves `enabled` where it found it. The version of this change
that sends the key unconditionally is the version that silently reverts the header.

The route needed no change: `…/config` has accepted `conditionalTopics` since the settings
export/import round-trip required it, merging through `patchConditionalTopicsSettings` — the same
helper this tab's PATCH uses — inside the same fork decision, so an edit to a launched version
forks exactly once.

The three conflicts that only fire when scope is on (`conditional-topics-targeted-opening`,
`-no-probes`, `-guided-openings`) now read the Settings tab's **live** switch rather than the saved
config, so turning scope on there raises them while the admin is still deciding rather than after a
save and a reload. They stay anchored to `interviewer-strategy`: turning the feature off is not the
fix any of the three is asking for.

### Rows drag, and the buttons stay (F17.29)

The topic list reorders by drag (`@dnd-kit`, the same primitive the section and question editors
use) **and** keeps its up/down buttons. A drag is what forty topics need; the buttons are what a
keyboard reaches without learning a chord. The handle is a separate control rather than the whole
card being draggable — the collapsed line is itself the expand button, and the open row is full of
inputs, so a draggable card would start a drag on every click into a text field.

Both are disabled while a filter is applied, for the reason that predates the drag: "up" means the
row above **in the full set**, and with rows hidden that is not the row above on screen. The drop
logic is `reorderDrafts`, exported and pure — dnd-kit reads element geometry and a jsdom-class
environment reports every rect as zero, so a simulated drag never produces a drop, and the pure
function is where the behaviour is actually pinned. A drop outside the list is a no-op rather than a
move to index `-1`, which `arrayMove` would silently read as "the end".

### Three sub-tabs, named after the job (F17.26)

**Topics** (group the questions, mark the conditional ones) · **Rules & limits** (pin the
certainties, set how much one interview may cover) · **Check** (try the decision, then see what it
did). Not "Settings" for the middle one — the workspace tab bar above already has a Settings tab,
and two things called Settings on one screen is a collision an admin resolves by clicking both.

`ScopeExplainer`'s four steps deep-link into it: steps 1–2 → Topics, step 3 → Rules & limits, step
4 stays plain text because it is the header switch a few pixels above. That mapping is the argument
the split was worth making — the sequence the panel always described finally has somewhere to point.

**The tab state is local, and the URL is written with `history.replaceState`.** `useUrlTabs` writes
with `router.replace`, which on this route is a full RSC round-trip (`next.config.js` sets no
`staleTimes`), re-running four loaders to render markup that did not change — and a query-only
navigation that fell into the parent segment's `loading.tsx` would unmount the subtree entirely.
`components/admin/questionnaires/topics/use-scope-tabs.ts` keeps the `?tab=` addressability with none of that.

**`forceMount` on all three panels** is load-bearing rather than tidy. Radix unmounts an inactive
panel, and five things hold state that must survive a switch — most sharply the Routing Analyst's
in-flight SSE run, which has no `AbortController`, so unmounting does not stop the paid model call.
It only orphans the result.

The `RoutingAnalystCard` and the `TopicListEditor` **must stay on the same tab**: "Turn into topic"
appends an unsaved row to the editor, and firing that across a tab boundary would leave work the
admin never sees. Both are on Topics.

Three more things about the tab are load-bearing rather than cosmetic.

**The page teaches an order the controls cannot.** Conditional topics only works if it is authored in a
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
