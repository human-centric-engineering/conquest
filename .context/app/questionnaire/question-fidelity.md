# Question fidelity — "ask it as written" ↔ "fill it creatively"

The per-question dial between ConQuest's two legitimate postures.

The product's default is that a respondent never fills in a form: the interviewer converses, targets
[data slots](./data-slots.md), and fills the underlying questions in the background
([opportunistic fill](./opportunistic-fill.md)). The asking prompt makes that unconditional today —
`question-stream.ts`'s `rules` explicitly forbids reading out a choice list or asking for a scale
number, relenting only on a struggling re-ask.

That is right for most questions and wrong for some. A validated Likert battery, a regulatory
question, a matrix whose comparability depends on exact wording — these are **instruments**, and
paraphrasing them destroys the thing being measured. Fidelity is how an author says so, one question
at a time.

## The five stops

Stored on `AppQuestionSlot.fidelity` (Float) and snapped to a five-stop grid, because each stop maps
to one distinct behaviour. A continuous dial would imply a resolution the runtime cannot act on.

| Stop         | Value  | Interviewer behaviour                                                  |
| ------------ | ------ | ---------------------------------------------------------------------- |
| **Free**     | `0`    | Never needs to surface at all — inference carries it                   |
| **Loose**    | `0.25` | May approach the underlying idea from any angle                        |
| **Balanced** | `0.5`  | **Today's behaviour** — open invitation, reply mapped for them         |
| **Close**    | `0.75` | May paraphrase, but keeps the author's terms, qualifiers and timeframe |
| **Must ask** | `1`    | Asked as written; typed questions get their real answer control inline |

## Two layers of no-op — why nothing changes on deploy

This is the load-bearing property, and it is deliberately belt-and-braces:

1. **The column default is `0.5`** — `balanced`, which emits no prompt clause. Every pre-existing
   question is untouched.
2. **The version gate is off** — `AppQuestionnaireConfig.questionFidelity` (`{ enabled,
defaultFidelity }`) defaults to `{}`, which narrows to `enabled: false`. While it is off,
   `resolveQuestionFidelity()` returns `balanced` for **every** question whatever is stored.

The second layer exists so an admin can set levels across a long questionnaire _before_ switching the
behaviour on — and switch back without losing that work.

> **`resolveQuestionFidelity(storedFidelity, settings)` is THE read seam.** Reading `slot.fidelity`
> directly anywhere in the runtime would apply a stored value on a questionnaire whose admin never
> turned the feature on. Go through the resolver.

## The satisfaction bar

Fidelity does not only shape the wording — it also decides **how confidently a question must be
answered before it stops needing to be asked**. `questionSatisfactionFloor()`
(`selection/context.ts`) takes the admin's `answerConfidenceFloor` and raises it:

| Level                   | Floor                   |
| ----------------------- | ----------------------- |
| free / loose / balanced | the configured floor    |
| close                   | `max(configured, 0.65)` |
| must_ask                | `max(configured, 0.85)` |

**Fidelity only ever RAISES the bar.** Turning the feature on can never let a session complete on
weaker evidence than it would have before — the worst it can do is ask for more. That is also why
`free` sits at the configured floor rather than `0`: `free` means "you need not ask this directly",
not "a 0.3 tangential guess is good enough to finish on".

This is the mechanism behind _"must ask it — unless it has already been filled tangentially with
high confidence"_, and it needs no new tuning. An opportunistic fill is already capped at `0.75`
(typed) / `0.45` (free text) by `opportunistic-fill.ts`, so a background fill can **never on its own**
satisfy a must-ask question. Only a genuine `direct` extraction, or corroboration climbing via
`accrueConfidence` toward the `0.95` ceiling, clears `0.85`.

Two consumers:

- **`assessCompletion`** (`completion-logic.ts`) gates per question instead of on one flat floor. A
  below-bar answer doesn't count toward coverage or the minimum, and doesn't unblock a required
  question.
- **`terminalDecision`** (`selection/context.ts`) holds the session open while any **must-ask**
  question sits below its bar, even once the coverage thresholds are met — an instrument question the
  respondent was never actually asked is the exact failure this feature exists to prevent. `close`
  deliberately does **not** block here: it raises the completion floor but is not a "you must be
  asked this" guarantee.

> **The cap is the backstop.** The must-ask block sits _after_ the `maxQuestionsPerSession` check, so
> the cap still force-completes. This matters: a respondent who keeps answering vaguely could
> otherwise never finish. The same "can block until the cap" property already exists for required
> questions and for `answerConfidenceFloor` — this raises the bar on an accepted mechanism rather
> than adding a new kind of dead end. Early finish and form mode remain available too.

The **display** coverage (`gradedCoverage`) deliberately still uses the flat configured floor. It is
progress-bar-only and its documented job is to show momentum a strict gate can't, so a must-ask
answered at 0.7 shows partial progress while remaining gated.

## The prompt clause

`buildQuestionFidelityInstructions()` (`lib/app/questionnaire/chat/question-fidelity.ts`) renders the
`<question_fidelity>` section — the per-question sibling of `interviewer-strategy.ts` and
`house-rules.ts`. It returns `''` at `balanced`, so `section()` collapses it away and the prompt is
byte-identical to before the feature.

**Placement is load-bearing.** The section sits AFTER `<rules>` and `<interviewer_strategy>`, on the
prompt's later-section-wins convention. The standing `rules` tell the interviewer to ask openly,
never read out a choice list, and never request a scale number; at `close`/`must_ask` this block
directly contradicts them. Placed earlier, a must-ask Likert question would still be asked as an open
feelings question.

Two things change in the **user** message too:

- The question line becomes `Ask this question EXACTLY as written…` at `must_ask` (and names the
  wording as load-bearing at `close`), instead of the neutral "The question to ask".
- The existing `clarifyGuidance` machinery (`extractOptionLabels` / `extractLikertScale` /
  `extractMatrix`) fires **on the first ask** at `must_ask`, not only after a failed re-ask. Waiting
  for a failure would defeat the point of marking a question must-ask. It is framed as an
  instruction there, and stays a concession ("this time you MAY gently offer…") on the ordinary
  struggling re-ask, which is otherwise untouched.

The renderer takes an `answerControlShown` flag: when the surface renders a real answer control
beside the message, the prose must not also recite the options. Phase 2 always passes `false`; the
in-chat question card will pass `true`.

## The question card

For a **typed** `must_ask` question the respondent answers the real control, rendered inside the
chat turn — not a prose rendering of its options. Reading a five-point scale out and mapping whatever
they say back onto it is precisely the inference `must_ask` exists to switch off.

```
Interviewer (streamed prose)
  "That's helpful. Before we leave workload, there's one
   I need to put to you exactly as it's written:"

 ┌──────────────────────────────────────────────┐
 │ Asked as written                    Required │
 │ How satisfied are you with your current      │  ← verbatim `prompt`
 │ workload?                                    │
 │   1 ──── 2 ──── 3 ──── 4 ──── 5              │  ← <QuestionField>
 │   Not at all           Extremely             │
 │                              [ Submit ]      │
 │  I'd rather answer in my own words           │
 └──────────────────────────────────────────────┘
```

**Nothing new was built to render or persist it.** The control is `QuestionField` (the raw form's
per-type dispatcher); the write is `useInlineCorrection` → `PUT …/answers` (the path the correction
strip already uses), which records provenance `direct`, confidence `1`, and `respondentEdited` — so
no later chat turn can overwrite what the respondent picked themselves.

### When it appears

`shouldShowQuestionCard()` (`chat/question-card.ts`), in order:

1. **Behind the version gate** — including the last-resort path below, so enabling nothing changes
   nothing.
2. **Never for free text.** There is no control to render; the protected thing is the wording, and
   the respondent answers in the ordinary composer. A deliberate product decision.
3. **Never when the control can't render** — a `single_choice` with no choices, a `likert` with
   broken bounds. `canRenderAnswerControl()` reuses the _same_ readers `QuestionField` dispatches on,
   so "can we render it?" and "what gets rendered" cannot drift. Falling back to prose still asks the
   question; rendering an empty radio group would be a dead end.
4. **`must_ask`** → reason `must_ask`.
5. **Otherwise, on a re-ask** → reason `last_resort`. This is the generalised _"the only other time
   it presents the raw format is when it can't fill the question any other way"_: rather than asking
   a third time in prose, hand over the control. The two reasons carry different copy — one is a
   deliberate design, the other a rescue, and labelling a rescue as intent misleads the respondent.

### The wire, and resume

A `question_card` SSE frame, emitted **after** the lead-in prose so the card reads as the thing the
message hands over to. Narrowed defensively in `parse-session-event.ts`: a payload missing
`questionKey` / `prompt` / `type` is **dropped**, because the prose already asked the question, but a
card whose Submit has nowhere to write is worse than no card.

Only `AppQuestionnaireTurn.questionCardKey` is persisted. On resume the card is **rebuilt from the
live slot**, so an admin who rewords a question between sessions doesn't leave a stale snapshot
pinned in a transcript. It is suppressed in three cases: the question has since been **answered**
(replaying a live control over an existing answer invites a second submission that would overwrite
the first), the question can **no longer render a control**, or the version **gate has since been
switched off** — the control is interactive, so replaying it after an admin disabled the feature
would let a respondent still submit through it. The gate rides the same query traversal, so a
session with no cards still makes no extra round-trip.

The chat keys **dismissal on the turn, not the question**. Keyed on the question it would suppress
the control permanently: a dismissed must-ask stays unsatisfied, so the interviewer re-asks it — and
a prose answer cannot clear the 0.85 floor on its own (opportunistic fill caps at 0.75), so the
respondent would be stuck with no way back to the control that could answer it.

The chat renders the card for the **latest turn only**. A card left attached to an older turn would
invite answering something the conversation has moved past.

### After a submit

The client calls `continueAfterCard(questionKey)` → `POST …/messages` with `answeredQuestionKey` and
**no message**. The answer is already persisted, so this turn exists only for the interviewer to
acknowledge it and move on. Passing the value as a fake user message would leak a form value into the
transcript and re-run extraction over text the respondent never typed. The route adds one briefing
line telling the interviewer to acknowledge briefly and **not** repeat the answer back.

`answeredQuestionKey` also rides on the `TurnState`, because a message-less turn is otherwise
indistinguishable from the opening turn. [Contradiction
checking](./contradiction-detection.md#which-turns-are-checked) reads it to decide whether anything
arrived worth checking: until 2026-08-30 it gated on the typed message alone, so a respondent working
through a questionnaire on cards was never checked mid-conversation — their conflicts surfaced only
at the submit sweep. Answering by tapping is a first-class way to answer, not a way to skip the
checks.

The escape hatch ("I'd rather answer in my own words") dismisses the card without marking the
question answered — the interviewer still comes back to it — so it cannot be used to dodge a required
item.

## Targeting: naturally, but guaranteed

A must-ask question can't be left to the abstraction layer to infer, but firing it the moment it
becomes eligible would interrupt a theme mid-flow. So in data-slot mode `runDataSlotTurn` hoists it
when **its own ground has been worked through** — every data slot mapping it is covered — and asks it
directly, _before_ bridging to a new theme. A question no data slot claims has no topic to wind up
and is asked as soon as it's eligible. The end-of-run sweep stays the backstop.

Two supporting changes:

- **`allQuestionsAnswered`** (the data-slot submit gate) additionally requires no outstanding
  must-ask. That gate is count-based on purpose — making it floor-aware wholesale would tighten
  completion for every questionnaire, not just the ones using fidelity — so this adds one condition
  rather than changing its meaning.
- **`weightedScores`** multiplies a must-ask question by `MUST_ASK_MULT` (100), large enough that the
  lightest must-ask outranks the heaviest ordinary question at full bonus. Multiplying rather than
  tiering keeps the rest of the scoring intact: among several must-asks, weight and section coverage
  still decide the order.

### `selectableQuestions` — the invariant that keeps this safe

Holding the session open for a below-bar must-ask is only coherent if a strategy can actually pick
it. But the question _has_ an answer row, so `unansweredQuestions` drops it — and every strategy
dereferences `pool[0]` on the strength of "`terminalDecision` returned null ⇒ the pool is non-empty".

`selectableQuestions()` restores that invariant: unanswered questions **plus** any `must_ask`
question below its floor. `terminalDecision` reads the _same_ function, so the two cannot disagree.

> **Keep them in step.** A divergence here is a crash in a live respondent turn, not a wrong answer.
> There is a test that walks the fidelity × confidence matrix asserting the invariant directly.

Only `must_ask` re-enters the pool. `close` raises the completion floor but promises nothing about
being asked, so re-targeting it could loop on a question the respondent has already answered as well
as they are going to.

## What fidelity is not

- **Not `weight`** — weight is how strongly the _weighted_ strategy favours a question and how much
  it counts toward coverage. Fidelity says nothing about whether to ask, only how.
- **Not `required`** — required is whether it must be answered at all.
- **Not Conditional Topics.** [Scope](./conditional-topics.md) decides _whether_ a question applies to this
  respondent; fidelity decides only _how_ it is asked. Scope wins by construction: `buildTurnContext`
  filters questions through `buildSessionScope` before anything downstream sees them, so an
  out-of-scope must-ask is simply absent. A must-ask question is never a reason to widen scope.

## Where each piece lives

| Concern                                | Code                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stops, labels, clamp, narrow, resolver | `lib/app/questionnaire/types.ts` (`QUESTION_FIDELITY_STOPS`, `clampQuestionFidelity`, `narrowQuestionFidelity`, `resolveQuestionFidelity`)                                     |
| Schema columns                         | `AppQuestionSlot.fidelity`, `AppQuestionnaireConfig.questionFidelity` (migration `…_app_question_fidelity`)                                                                    |
| Zod (question PATCH)                   | `lib/app/questionnaire/authoring/schemas.ts` (`createQuestionSchema` / `updateQuestionSchema`)                                                                                 |
| Zod (config PATCH)                     | `lib/app/questionnaire/authoring/config-schema.ts` (`questionFidelitySchema`)                                                                                                  |
| Read projection                        | `app/api/v1/app/questionnaires/_lib/detail.ts` (question select + `toConfigView`)                                                                                              |
| Per-question control                   | `components/admin/questionnaires/question-editor.tsx` (`FidelityControl`)                                                                                                      |
| New-question default                   | `…/sections/[sectionId]/questions/route.ts` — applies `questionFidelity.defaultFidelity` on create (the midpoint while the gate is off, or whatever the body names explicitly) |
| Admin preview context                  | `app/api/v1/app/questionnaires/_lib/selection-context.ts` — must carry `fidelity`, or the `/next-question` preview silently diverges from the live turn loop                   |
| Turn-evaluator context                 | `app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context.ts` (`describeTurnFidelity`) — tells the judge how faithfully THIS turn's question had to be put           |
| Section bulk-set                       | `components/admin/questionnaires/section-editor.tsx` → `PATCH …/versions/:vid/questions`                                                                                       |
| Settings gate                          | `components/admin/questionnaires/config-editor.tsx`, "Questions & completion" group                                                                                            |
| Pack / audit summary                   | `lib/app/questionnaire/settings-registry.ts` (`questionFidelity` descriptor)                                                                                                   |
| Instrument + pack export               | `lib/app/questionnaire/export/build-instrument-model.ts` (`InstrumentQuestion.fidelity`) — resolved once per question; `null` when the gate is off                             |
| Export renderers (6)                   | `build-instrument-{text,csv}.ts`, `build-pack-{markdown,csv}.ts`, `components/app/questionnaire/export/{instrument,pack}-pdf-document.tsx`                                     |
| Fork / duplicate / clone               | `app/api/v1/app/questionnaires/_lib/copy-version-graph.ts` (question select **and** create)                                                                                    |
| Definition export / import             | `lib/app/questionnaire/authoring/definition-export.ts`, `_lib/import-definition.ts`                                                                                            |

Settings **export/import is automatic** — `CONFIG_KEYS` derives from `DEFAULT_QUESTIONNAIRE_CONFIG`.
The per-question field is **not**: it must be named in the definition envelope and the fork copier.

## Bulk setting

`PATCH …/versions/:vid/questions` takes `{ required?, fidelity?, sectionId? }` (at least one of
`required` / `fidelity`). `sectionId` narrows the update to one section — fidelity is usually uniform
within a section (a scored battery is all-or-nothing), and dragging seventy sliders one at a time is
not a real workflow. When the PATCH forks a launched version the route re-resolves `sectionId` onto
the **copied** section by ordinal; without that it would match nothing and silently update zero rows.

Audit actions are kept distinct rather than folded together, so existing history stays queryable:
`questionnaire_question.bulk_required` (required only, unchanged), `…bulk_fidelity` (fidelity only),
`…bulk_update` (both).

## The export has to say it too

A blank instrument that prints only the prompt cannot distinguish a question that will be put word
for word, with its scale read out, from one that may never be asked aloud at all. Both are in the
document; only one of them is a script. So `InstrumentQuestion` carries the resolved level and all
six renderers print it beside the type and the required flag — the branded Questionnaire Pack and
the brand-free instrument export share one model, so this is one field and six one-line changes.

`null` when the gate is off, and the renderers print nothing at all in that case: with the gate off
every question resolves to `balanced`, so a uniform column would be noise on the large majority of
questionnaires that never opted in. The two CSV writers keep the **column** either way — a stable
shape is what a spreadsheet consumer needs — and leave the cell empty.

## The judge has to be told

`must_ask` is the one stop that makes a _correct_ turn look wrong to an automated reviewer. The
turn-evaluator's rubric scores `openEndedness`, `nonLeading` and `specificity`; putting a question
verbatim and reciting its scale is the opposite of open and reads as leading, so a compliant
must-ask turn was being marked down for doing exactly what the author asked.

So the evaluator is handed two things it did not have before: the version-level gate, and — via
`describeTurnFidelity` — the resolved level for the question _this_ turn asked about. The level is
resolved server-side through `resolveQuestionFidelity`, never taken from the request body: on the
saved-turn path from the row's `targetedQuestionId`, and on the live drawer path from the rendered
card's `questionKey` (so the live path covers `must_ask` and last-resort re-asks, and falls back to
version-level context elsewhere). `balanced` is omitted — it is the behaviour the rubric already
assumes.

The rubric clause that reads it is pinned by `TURN_RUBRIC_VERSION`, which moved to `1.1.0` when this
landed: a score is only comparable to another score under the same rubric.

## Anti-patterns

- **Don't** read `slot.fidelity` directly in runtime code — use `resolveQuestionFidelity`, or you
  will apply a dial the admin never switched on.
- **Don't** let a must-ask question override Conditional Topics. Out of scope means not asked, full stop.
- **Don't** add a stop between the five. Each stop is a distinct prompt clause; a sixth value that
  behaves like its neighbour is a lie told to the admin.
- **Don't** emit an answer-control card for `free_text` at Must ask. There is nothing to render; the
  protected thing is the wording, and the respondent answers in the composer as usual.
- **Don't** let `selectableQuestions` and `terminalDecision` drift apart — every strategy assumes
  they agree, and a divergence crashes a live turn.
- **Don't** send a card's answer as a chat message. It is already persisted; a fake user message
  would leak a form value into the transcript and re-run extraction over text nobody typed.
- **Don't** persist the card's rendered content. Store the key and rebuild from the live slot, or a
  reworded question leaves a stale copy pinned in every resumed transcript.
- **Don't** read `fidelity` in a new context builder without adding it to that builder's Prisma
  select. There are now three — `turn-context.ts` (live), `selection-context.ts` (admin preview) and
  `turn-evaluation-context.ts` (the judge) — and a preview that resolves everything to `balanced`
  tells an admin the feature is broken when it isn't.
- **Don't** suppress the card on a per-question flag. Dismissal must be per-turn, or a dismissed
  must-ask can never be answered.
- **Don't** hand-wire the _settings_ block into import/export — it flows from
  `DEFAULT_QUESTIONNAIRE_CONFIG` automatically. Do hand-wire the _per-question_ field.

## Status

- **Phase 1** — the knob: columns, schemas, admin controls, and the full fork/export/import carriage.
  No respondent behaviour.
- **Phase 2** — the prompt clause + the satisfaction bar (this document's later sections). The
  interviewer now honours fidelity in how it words and presents a question, and a below-bar must-ask
  keeps the session open.
- **Phase 3** — the in-chat **question card**, the `question_card` frame and its resume replay, and
  the "naturally but guaranteed" targeting. Feature-complete.
