# Interviewer-policy evaluation (F18.8)

The third judge panel. The [design-evaluation panel](../planning/features/f5.1.md)
scores the **questions**; the [Adaptive Scope panel](./adaptive-scope.md#scope-evaluation-f1721)
scores the **routing**; this one scores the **interviewer policy** — the client's house rules, the
questioning arc, and the per-question ask-as-written dial, which together decide how every question
is actually put to a respondent.

## Why a panel and not more lints

`authoring/config-conflicts.ts` already runs 20 mechanical checks over this same config, and they
are free. What they answer is "is this well-formed": a rule that fights a setting the engine
controls, an opening example that can never be used, a rule promising more anonymity than the
questionnaire offers.

What nothing answered is whether the policy is any **good**:

- Is a rule too vague to change any turn? ("Be appropriate.")
- Does a brisk funnel suit a reflective 60-question instrument?
- Is the fidelity dial set coherently across a scored battery — or half of it?
- Does "never use humour" quietly override the humour dial the admin set to +2?

Those are judgement calls, and the two sibling panels had already established that judgement calls
about a questionnaire get a panel of blind judges with a reviewable finding queue.

## The four dimensions

Each targets a different object, and that separation is what keeps the rubrics clean.

| Dimension              | Reads                                         | Judges                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rule_coherence`       | the rules array, as prose                     | Rules that contradict each other, duplicate each other, or are too vague to change a turn. An `if_asked` trigger too broad or too narrow to fire correctly. A rule addressed to the respondent rather than the interviewer. |
| `arc_fit`              | the strategy blob + its resolved pace profile | Whether approach, pace, opening and tactics suit this goal, audience and length.                                                                                                                                            |
| `fidelity_calibration` | N question rows                               | Whether the dial is set deliberately. **Headline case: the gate is off while questions carry non-Balanced values** — forty sliders doing nothing.                                                                           |
| `cross_layer_conflict` | all of the above, plus tone and routing       | The **only** judge permitted to reason across blocks.                                                                                                                                                                       |

Without the fourth, each of the other three would have to carry the whole interaction table, and one
finding would appear three times with three different fixes.

### A fifth dimension was considered and rejected

"What rule is this questionnaire missing?" — rejected because `house-rules/suggest.ts` is a shipped
assistant whose entire job is proposing rules, and it reads the glossary and the existing rules to do
it. A dimension whose output duplicates an assistant is how an admin learns to stop reading the
panel. It survives as a **capped one-per-run `info` clause** inside `rule_coherence` that points at
the Suggest button.

## No reconciler — but not for the scope panel's reason

The scope panel argued its four dimensions target different fields of different objects, so a
collision mostly cannot occur. **That argument does not hold here**, and copying the sentence would
have been wrong: `cross_layer_conflict` can propose an edit to the same house rule as
`rule_coherence`, the same strategy field as `arc_fit`, and the same question as
`fidelity_calibration`.

There is still no reconciler, on three different grounds:

1. **The overlapping fields are enums and numbers, not prose.** The design panel's reconciler exists
   because two judges rewrite one question's _prompt_ with two incompatible paragraphs. `funnel`
   against `targeted`, side by side on one card, is legible in a second.
2. **Grouping does the reconciler's presentation job** — both findings land under one target with
   both rationales visible.
3. **Per-op staleness does its safety job** — once one applies, the other's apply 409s.

Two things become load-bearing as a consequence, and both belong to the apply engine rather than the
panel: the apply route must resolve the run's existing review draft **before** building the
comparison state, and staleness must compare **only the op's own field** — a `default:` branch that
stringifies the whole strategy blob would mark every strategy finding stale the moment one applied,
and the panel would look broken.

## Targets

`house_rule:<id>` · `house_rules` · `strategy` · `fidelity` · `tone` · `question:<key>`

`house_rule:` rather than `rule:` is deliberate — the scope panel owns `rule:<id>` for a hard routing
rule, and a pack printing both appendices must never mis-resolve one as the other.

### Keeping `question:<key>` apart from the design panel

The design-evaluation panel also targets questions. Four separations:

1. **Different surfaces**, never one queue.
2. **One question-touching op, and it is not a wording op.** A policy finding on a question can only
   ever say "move this slider", so two panels can never propose different prompts for one question.
3. **The group label reads `Fidelity — "<prompt>"`**, so the reader is told which subject is being
   judged before they read the finding.
4. **No deep-link applicability** — applying moves the slider in place; policy findings never open
   the question editor.

## The ops

Twelve, each writing exactly one field that already exists. Deliberate omissions:

- **No question-content ops** — the design panel owns question wording.
- **No `edit_opening_examples`** — the opening-examples assistant owns that text.
- **No persona swap** — a persona is a whole `ToneSettings`, not a one-field write.
- **No `houseRules.enabled` / `interviewerStrategy.enabled` master switches** — flipping either
  silently voids a client's entire authored policy, too much blast radius for one click.
- **`set_fidelity_enabled` IS allowed, in both directions.** The asymmetry is the point: that gate is
  the one switch whose flip destroys nothing (per-question values persist either way — the entire
  reason for the two-layer no-op design), and "you set forty sliders and never turned it on" is the
  best finding the panel can produce. Prose-only would leave the best result unactionable.

**The Zod is borrowed, not re-declared.** `edit_house_rule` and `add_house_rule` build on
`houseRuleBodySchema` from `authoring/config-schema.ts` — the same schema the config PATCH validates
against — so a judge's proposed rule is held to exactly the invariant a saved rule is. Above all the
one judges get wrong most often: **`trigger` belongs to `if_asked` and to nothing else.**

## What the judges are fed

Everything a judge must not re-derive is pre-computed by `_lib/policy-evaluation-structure.ts`:

| Field                         | Why it is handed over                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy.paceProfile`        | `arc_fit` reasons about "3 opening asks, targeted above 85% coverage". A judge inventing those numbers is a judge inventing the feature. `paceProfile()` also honours the funnel-only rule, so it never describes a pace the runtime ignores. |
| `fidelity.satisfactionFloors` | Computed against _this_ version's `answerConfidenceFloor`, so the judge sees the real bar rather than the constant.                                                                                                                           |
| `fidelity.distribution`       | Complete even when the question sample is cut.                                                                                                                                                                                                |
| `routing.mustAskByTopic`      | Makes "must-asks in a topic routing may never seat" checkable in one line rather than a 200-row join a model does badly.                                                                                                                      |
| `knownIssues`                 | `detectConfigConflicts` output **with stable ids**, printed as `- [warning/house-rules-format-override] …`, so a rubric's ignore clause can name ids and a judge matches id to id rather than paraphrase to paraphrase.                       |

Each question carries **both** `level` (gate-honoured) and `storedLevel` (raw) — the headline "gate
off, sliders set" finding needs the pair.

### Two things this panel does that the scope panel does not

**Per-dimension sections.** `SECTIONS_FOR` decides what each judge is _shown_. The scope panel
serialises its whole config for every judge because a scope config is small; a policy DTO can carry
150 question prompts and three of the four rubrics have no use for them. The DTO stays one shape —
one schema, one capability arg, one snapshot column — only the rendering varies. **Do not "fix" this
back to parity.**

**Sampling that tells the truth.** `MAX_POLICY_EVAL_QUESTIONS = 150`, and it is not a blind head-N:
every question whose stored value is not `balanced` is kept, the remainder fills in document order,
and the prompt says _"you are seeing 150 of 320, chosen to include every non-Balanced question; the
distribution below is complete."_ A judge told the truth about its sample stops inventing findings
about the part it cannot see.

## Form-only questionnaires are refused before dispatch

`presentationMode: 'form'` means the interviewer never runs, so the whole policy layer is inert — and
the conflict checker already says so four different ways. The preview route 409s
`PRESENTATION_FORM_ONLY` **before** dispatching. Four paid LLM calls to be told the conversation does
not exist is the kind of waste that reaches a bill.

## Where it lives

The preview card sits on the **Settings page**, directly below the Config Advisor — the slot whose
stated reason ("the advice is read before tweaking") is exactly this panel's, one layer more
specific. Not inside any one `SettingsGroup`: one of its four reviewers is about the arc, one about
the questions, and one about how all of them interact.

**The dirty-editor guard has no precedent on the Topics tab and is load-bearing.** Settings is an
editor holding unsaved state; the panel judges saved config. Without it an admin runs four paid
judges against something other than what is on screen, reads findings about text they already
changed, and reasonably concludes the panel is broken.

## The barrel does not re-export `run-panel.ts`

It imports the capability dispatcher → Prisma → `pg` and its node built-ins. Three **client**
components import `POLICY_EVALUATION_DIMENSION_SPECS` and `describePolicyProposedEdit` from the
barrel, so a re-export breaks `next build` with "Module not found: net" the moment one renders.
Server callers import `runPolicyEvaluationPanel` from its own leaf. The scope panel learned this the
hard way.

Two further purity constraints, neither obvious:

- `judge-prompt.ts` legitimately imports `FUNNEL_PACE_PROFILES` from `chat/interviewer-strategy.ts`.
  That file is pure (`isRecord` + `narrowPromptText`), so it is safe — but it is the first time an
  evaluation prompt builder reaches into `chat/**`, and the next reader will assume it is a mistake.
- `describe-op.ts` imports **nothing but `types.ts`**. It is shared by a client component and the
  pack builder; a stray import would drag a graph into the browser for one switch statement.

## Files

| Path                                                                | What                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `lib/app/questionnaire/policy-evaluation/`                          | The pure core — types, dimensions, judge schema, structure schema, prompts, panel dispatch, op describer |
| `lib/app/questionnaire/capabilities/evaluate-policy.ts`             | The dispatched capability, one judge per call                                                            |
| `app/api/v1/app/questionnaires/_lib/policy-evaluation-structure.ts` | The DB seam — everything pre-computed                                                                    |
| `.../[vid]/policy/evaluate-preview/route.ts`                        | The ephemeral preview                                                                                    |
| `components/admin/questionnaires/policy-evaluation-card.tsx`        | The card                                                                                                 |
| `prisma/seeds/app-questionnaire/095`, `096`                         | Four judge agents, one capability row                                                                    |

## Anti-patterns

- **Don't** re-declare a field schema this panel proposes edits to. Borrow the config PATCH's, or a
  judge's proposal will be held to a looser standard than a human's.
- **Don't** send every section to every judge. Three rubrics have no use for the question list.
- **Don't** copy the scope panel's "no collision is possible" reasoning — here it is false.
- **Don't** add a master-switch op. Voiding a client's whole policy is not a one-click action.
- **Don't** let this panel propose question wording. That is the design panel's job, and two panels
  rewriting one prompt is a queue nobody can reconcile.

## Persistence, review and apply

Runs persist as `AppQuestionnairePolicyEvaluationRun` + one row per finding, with a
`policySnapshot` of exactly what the judges read. `stale` is **never stored** — it is derived fresh
on every read by diffing the targeted slice of that snapshot against the live config.

### Staleness compares only the op's own field

This is load-bearing here in a way it is not on either sibling. Because the panel has no reconciler
_and_ a real collision case, per-op comparison is the only thing stopping the second of two
colliding findings from silently overwriting the first.

The trap: a `default:` branch that stringifies a whole block would mark **every** finding on that
block stale the moment any one of them applied. A reviewer would apply one strategy finding, watch
the other three grey out for no visible reason, and conclude the panel was broken. So
`set_pace` does not stale a `set_tactics` finding, `set_tactics` compares only the tactics it names,
and a tone finding compares only its own dial. Tests pin each of those.

One more subtlety: a `question:` finding whose question has dropped out of the **sample** is not
stale. The loader caps at 150 and prefers non-Balanced questions, so a question whose slider moved
to Balanced legitimately leaves the list while still existing. Claiming `removed` there would block
a perfectly good apply; the apply engine re-checks against the real row anyway.

### Apply

Three rules, all inherited from what F17.21's gate pass found the hard way:

1. **`current` is built against the version the apply will actually write to** — the run's existing
   review draft (`findRunReviewDraft`) when one exists, the route's `vid` only when it does not.
   More load-bearing here than on the siblings: one run routinely yields many
   `set_question_fidelity` findings, so multi-apply-per-run is the normal path.
2. **The op write and the `applied` stamp share one transaction.** `writePolicyOp` takes the
   transaction client as its **first** parameter so the mistake is hard to write. The named
   non-idempotent op is `add_house_rule`, which appends unconditionally.
3. **There is no provenance column to stamp — and that is the trap.** The scope panel could set
   `source: 'manual'` on an applied topic; neither `AppQuestionSlot` nor a house rule has an
   equivalent. So the audit log is the _only_ record that an AI suggestion, not a human, chose a
   value. That makes `logAdminAction` load-bearing rather than decorative, and its metadata carries
   **`previousValue`** — without it, an enum or number change is unreconstructible from history (you
   could see that a fidelity was set, never what it was set _from_).

`set_question_fidelity` is the only op writing outside the config JSON. It validates the slot
**pre-fork** so a doomed op never strands an orphan draft, then writes by the `(versionId, key)`
unique — never by row id, since a fork mints new ids while `copyVersionGraph` preserves the key.

Two ops are refused at apply time because they would deterministically **create** a conflict the
mechanical checker already warns about: `set_opening_mode: 'examples'` with no usable examples, and
`set_tone_dimension` while a selectable persona has replaced the version's dials. Text edits are
deliberately **not** blocked — the conflict checker's own rules are "never emit error" and "prefer a
missed warning to a noisy one", and a blocking gate driven by keyword matching would violate both.

### One genuinely new helper

`patchVersionConfigBlocks(versionId, patch, tx?)` in `_lib/config-routes.ts`. There was no
transaction-aware read-modify-write seam for the plain config blocks — `patchAdaptiveScopeSettings`
covers only adaptive scope, and the config PATCH route does an inline upsert over a whole validated
body. Modelled on the former, down to the optional `tx`.

## In the Questionnaire Pack

A **new top-level `PackInclude.interviewerPolicy` flag**, defaulting `false`. Not nested under
`setup`, for two reasons: `setup` is a flat list across ~15 groups, so nesting a verdict about three
of them would attach a judgement to twelve things it never read — and `setup` defaults **true**,
which would ship unreviewed AI critique into every default download.

The section renders the policy in plain language (rules by kind, the arc's bands, the fidelity
distribution) with the panel's verdict nested inside it. The arc bands derive from the same
`FUNNEL_PACE_PROFILES` the runtime reads — the `FunnelArcExplainer` trick applied to the pack, since
a hard-coded table that drifted would be worse than none. `hasRun: false` still renders.

## Status

Shipped. Both phases: the panel and preview (PR A), then persisted runs, the review queue,
one-click apply and the pack section (PR B). See
[`f18.8.md`](../planning/features/f18.8.md).
