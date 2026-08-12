# Adaptive Scope

**Which parts of a questionnaire apply to this respondent, and who decides.**

ConQuest already decides two things: **which question next** (selection strategies) and **which
questionnaire next** (the Experience switcher). Adaptive Scope is the gap between them. Screeners,
eligibility checks, role-specific question sets, compliance sections that must be recorded as
not-applicable, and any long instrument that should not ask all of itself to everyone are all the
same requirement — and before P17 the only way to express it was to split the questionnaire into
several, which costs cross-section scoring and cohort analysis.

> **Status:** F17.1–F17.3 shipped (model, runtime, planner). The admin authoring surface, the
> Routing Analyst, and the report/scoring awareness are tracked in `planning/features/f17.*.md`.

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
2. **The judgement** (`scope/planner.ts`). One call over the author's criteria and what the
   respondent actually said. Skipped entirely when there is nothing to decide.
3. **Guardrails** (`scope/guardrails.ts`). The cap, the blind-spot check, the fallback.

> **The model proposes; it never gets the last word on a hard constraint.** Six numbered rules in a
> system prompt are obeyed _most_ of the time, which is the worst possible failure mode — plausible
> plans that quietly break the limit an author set, with nothing to catch them.

### Guardrail order

```
rule excludes ─> rule includes ─> the cap ─> the blind-spot check ─> the fallback
                      ▲                            ▲                      ▲
        seated BEFORE the cap so a          drawn from what did      only when nothing
        model's enthusiasm cannot            NOT make the cut         at all was seated
        truncate an author's "always"
```

### The blind-spot check

One conditional topic that was **not** selected, sampled at `light` depth (its highest-weight
members). A diagnostic that only asks about the problem the respondent already named can only
confirm what they already believed; sampling one area they did not raise is what makes the result
capable of surprising them.

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

The announcement rides the existing **briefing** seam into the phraser, on the one turn following the
decision (`decidedAtTurn === selectionRound`). The interviewer weaves it in its own voice — "based on
what you've said I want to go deeper on pipeline and forecasting" reads as the same person still
talking, where a prepended paragraph reads as a system notice.

---

## Auditability

Every plan is recorded as an `AppAiRun` of kind `scope_plan` — **including the ones no model
produced**. A hard rule, the fallback, or an interview with nothing to decide all leave a row, with
`provider`/`model` reading `deterministic` so cost trends stay clean.

"Why did this respondent get those topics" is the question an admin asks about an adaptive instrument
months later, and a deterministic answer is as worth defending as an inferred one.

---

## Coherence checks

`validateAdaptiveScope` runs on read (the Topics page, the launch checklist) rather than blocking
saves — an admin mid-edit routinely has an incoherent set, and a surface that refuses the save is a
surface they fight.

The check that matters is **`orphaned_questions`**: with scope active, a question belonging to no
topic can never be asked, and nothing else in the system would report it. It is an `error` when the
feature is on and a `warning` when it is off — the second being exactly what an admin needs to see
_before_ flipping the switch.

---

## Files

| Path                                                                | What                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/app/questionnaire/scope/types.ts`                              | Vocabulary, settings, plan shape, narrowers. A **leaf** — it carries its own `narrowToEnum` copy so `types.ts` can hold an `AdaptiveScopeSettings` without a runtime import cycle |
| `lib/app/questionnaire/scope/resolve.ts`                            | The pure filter                                                                                                                                                                   |
| `lib/app/questionnaire/scope/rules.ts`                              | Hard-rule evaluator                                                                                                                                                               |
| `lib/app/questionnaire/scope/guardrails.ts`                         | Cap, check topic, fallback                                                                                                                                                        |
| `lib/app/questionnaire/scope/planner.ts`                            | The model call; never throws                                                                                                                                                      |
| `lib/app/questionnaire/scope/seed.ts`                               | One topic per section, pure                                                                                                                                                       |
| `lib/app/questionnaire/scope/validate.ts`                           | Coherence findings                                                                                                                                                                |
| `app/api/v1/app/questionnaires/_lib/session-scope.ts`               | The DB seam                                                                                                                                                                       |
| `app/api/v1/app/questionnaires/_lib/seed-topics.ts`                 | Seeding + reconcile-after-rewrite                                                                                                                                                 |
| `app/api/v1/app/questionnaire-sessions/_lib/plan-scope.ts`          | The post-turn trigger                                                                                                                                                             |
| `app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/route.ts` | GET / PUT / PATCH                                                                                                                                                                 |

## Related

- [`../planning/features/f17.1.md`](../planning/features/f17.1.md) onward — the trackers
- [`../research/merlin5-growth-assessor.md`](../research/merlin5-growth-assessor.md) — the client
  requirement analysis this capability was generalised from
- [`experiences.md`](./experiences.md) — routing _between_ questionnaires, the sibling mechanism
