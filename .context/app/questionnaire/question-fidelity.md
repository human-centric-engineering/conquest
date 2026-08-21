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

## What fidelity is not

- **Not `weight`** — weight is how strongly the _weighted_ strategy favours a question and how much
  it counts toward coverage. Fidelity says nothing about whether to ask, only how.
- **Not `required`** — required is whether it must be answered at all.
- **Not Adaptive Scope.** [Scope](./adaptive-scope.md) decides _whether_ a question applies to this
  respondent; fidelity decides only _how_ it is asked. Scope wins by construction: `buildTurnContext`
  filters questions through `buildSessionScope` before anything downstream sees them, so an
  out-of-scope must-ask is simply absent. A must-ask question is never a reason to widen scope.

## Where each piece lives

| Concern                                | Code                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Stops, labels, clamp, narrow, resolver | `lib/app/questionnaire/types.ts` (`QUESTION_FIDELITY_STOPS`, `clampQuestionFidelity`, `narrowQuestionFidelity`, `resolveQuestionFidelity`) |
| Schema columns                         | `AppQuestionSlot.fidelity`, `AppQuestionnaireConfig.questionFidelity` (migration `…_app_question_fidelity`)                                |
| Zod (question PATCH)                   | `lib/app/questionnaire/authoring/schemas.ts` (`createQuestionSchema` / `updateQuestionSchema`)                                             |
| Zod (config PATCH)                     | `lib/app/questionnaire/authoring/config-schema.ts` (`questionFidelitySchema`)                                                              |
| Read projection                        | `app/api/v1/app/questionnaires/_lib/detail.ts` (question select + `toConfigView`)                                                          |
| Per-question control                   | `components/admin/questionnaires/question-editor.tsx` (`FidelityControl`)                                                                  |
| Section bulk-set                       | `components/admin/questionnaires/section-editor.tsx` → `PATCH …/versions/:vid/questions`                                                   |
| Settings gate                          | `components/admin/questionnaires/config-editor.tsx`, "Questions & completion" group                                                        |
| Pack / audit summary                   | `lib/app/questionnaire/settings-registry.ts` (`questionFidelity` descriptor)                                                               |
| Fork / duplicate / clone               | `app/api/v1/app/questionnaires/_lib/copy-version-graph.ts` (question select **and** create)                                                |
| Definition export / import             | `lib/app/questionnaire/authoring/definition-export.ts`, `_lib/import-definition.ts`                                                        |

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

## Anti-patterns

- **Don't** read `slot.fidelity` directly in runtime code — use `resolveQuestionFidelity`, or you
  will apply a dial the admin never switched on.
- **Don't** let a must-ask question override Adaptive Scope. Out of scope means not asked, full stop.
- **Don't** add a stop between the five. Each stop is a distinct prompt clause; a sixth value that
  behaves like its neighbour is a lie told to the admin.
- **Don't** emit an answer-control card for `free_text` at Must ask. There is nothing to render; the
  protected thing is the wording, and the respondent answers in the composer as usual.
- **Don't** hand-wire the _settings_ block into import/export — it flows from
  `DEFAULT_QUESTIONNAIRE_CONFIG` automatically. Do hand-wire the _per-question_ field.

## Status

- **Phase 1** — the knob: columns, schemas, admin controls, and the full fork/export/import carriage.
  No respondent behaviour.
- **Phase 2** — the prompt clause + the satisfaction bar (this document's later sections). The
  interviewer now honours fidelity in how it words and presents a question, and a below-bar must-ask
  keeps the session open.
- **Phase 3** (not yet built) — the in-chat **question card**: a real answer control (`QuestionField`)
  rendered inside the turn for a typed must-ask question, a new `question_card` SSE frame, and the
  "naturally but guaranteed" targeting that hoists a must-ask out of the data-slot abstraction as its
  theme winds up. Until then a typed must-ask question is asked verbatim in prose with its options
  read out.
