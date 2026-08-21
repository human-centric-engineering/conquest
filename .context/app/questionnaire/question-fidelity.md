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

Phase 1 (this document's subject) ships the **knob only**: the columns, the schemas, the admin
controls, and the full fork/export/import carriage. It changes no respondent behaviour — the runtime
does not yet read the resolver. Phases 2–3 add the prompt clauses, the satisfaction bar, and the
in-chat question card.
