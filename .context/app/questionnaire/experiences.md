# Experiences

**Experiences compose existing questionnaires into journeys.** The questionnaire stays the unit you
author; an experience decides which ones a respondent meets, in what order, and what carries between
them.

Admin surface: `/admin/experiences`. Code: `lib/app/questionnaire/experiences/**`,
`app/api/v1/app/experiences/**`, `components/admin/experiences/**`. Schema:
`prisma/schema/app-experience.prisma`.

## The two kinds

| Kind                  | Shape                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `agentic_switcher`    | An opening questionnaire, then an AI decision: conclude with a report, or continue into a chosen follow-up.       |
| `facilitated_meeting` | The same short questionnaire run by many people at once, synthesised per breakout for a live facilitator (F15.5). |

The switcher's routing is **general-purpose**. Nothing in the model or UI assumes a sales context —
triage into a specialist assessment, escalating depth on a topic, branching by role, and lead
qualification are the same mechanism pointed at different questionnaires. Keep it that way when
extending: the step kind is `branch`, not `upsell`; the terminal decision is `conclude`, not
`offer_report`.

## Where it sits relative to Rounds

Experience sits **above** `AppQuestionnaireRound` and does not replace it.

- A **round** is the time-boxed delivery of ONE questionnaire to a cohort. Unchanged.
- An **experience** sequences several questionnaires. It may reuse a cohort as its roster
  (`AppExperience.cohortId`) and a round's access window per step (`AppExperienceStep.roundId`).

Do not migrate `AppQuestionnaireRoundItem` into steps. It is an unordered set attached to a round;
steps are an ordered graph attached to an experience. They answer different questions.

## Data model

```
AppExperience
 ├─ demoClientId  → AppDemoClient   (real @relation, onDelete: Cascade)
 ├─ cohortId      → plain String    (UG-1, unmodelled)
 └─ steps[]       → AppExperienceStep (real @relation, onDelete: Cascade)

AppExperienceStep
 ├─ key                (@@unique([experienceId, key]))
 ├─ kind               entry | branch | breakout | report
 ├─ questionnaireId    → plain String (UG-1, unmodelled)
 ├─ versionId          → plain String (UG-1, unmodelled; null = newest launched at run time)
 └─ roundId            → plain String (UG-1, unmodelled)
```

### The FK posture matters

Config edges (`demoClientId`, `experienceId`) are real relations that cascade. **Target pointers
are not.** A real FK on `questionnaireId` would let archiving a questionnaire cascade away an
experience's authored structure and, through it, its run history — and it would make respondent data
reachable by walking config, which the UG-1 house rule exists to prevent.

The cost is that a pointer can dangle. The read seam (`_lib/read.ts`) resolves titles in a **batched
pair of queries** for the whole page and renders an unresolvable pointer as `null`, which the UI
shows as "may have been deleted". Never resolve a target per row, and never let a dangling pointer
throw.

`tests/unit/prisma/app-experience-schema.test.ts` asserts all of this. If you add a pointer, add it
there too.

## Continuity modes

```ts
EXPERIENCE_CONTINUITY_MODES = ['linked', 'stitched', 'merged'];
```

| Mode       | Persistence                        | Respondent sees                    | Phase |
| ---------- | ---------------------------------- | ---------------------------------- | ----- |
| `linked`   | one session per leg                | two chats with an explicit handoff | F15.2 |
| `stitched` | **identical to `linked`**          | one continuous chat                | F15.3 |
| `merged`   | one session, one synthetic version | one chat, genuinely                | F15.6 |

> **`stitched` is a presentation flag only.** Zero rows, zero write paths and zero report scoping
> differ from `linked`. That is what lets an experience switch between them mid-flight and what
> keeps F15.3 small. **If a change appears to require `stitched` to persist differently, the
> requirement is wrong — not the design.**

`merged` is the only mode that genuinely changes persistence, which is why it is last and may never
ship: `stitched` delivers most of the perceived value at a fraction of the cost.

**How the respondent actually travels a run** — the handoff wiring, the `/x/<publicRef>` stable
address, the httpOnly run credential and the seam marker — is
[`experience-continuity.md`](./experience-continuity.md).

## Settings

`AppExperience.settings` is a lazily-defaulted Json blob (`{}` resolves to
`DEFAULT_EXPERIENCE_SETTINGS`). Always read it through `narrowExperienceSettings`
(`experiences/settings.ts`) — never destructure the column.

A blob rather than columns because the facilitated-meeting kind is expected to accumulate many
per-experience variants. **Adding a setting should be a key plus a default, not a migration.**

The narrowing is deliberately strict: booleans do not coerce (a truthy string reads as the default,
not `true`), numbers clamp into range, and non-finite numbers fall back rather than clamping —
neither bound is a defensible reading of NaN.

`insightMinSupport` defaults to **3** and floors at 2. Two people can usually identify each other
from "a tension between two of you"; three is the smallest group where that stops being true.

## Explaining it (the How it works tab)

`/admin/experiences/[id]/how-it-works` answers "what am I building?" in three passes: **this
experience** as a live diagram, **the general shape** of its kind, then **worked examples**.

The live diagram exists because the Overview and Steps tabs both render a journey as a flat ordered
`<ol>`. That is fair for a facilitated meeting, which really is a sequence — but a switcher is a
branching decision wearing a list's clothes, and nothing in a list shows that rule order is
significant or that the selector only sees what the rules did not settle.

`buildExperienceDiagram(experience, rules)`
(`lib/app/questionnaire/experiences/diagram/build.ts`) is pure and client-safe: it maps the authored
rows onto a platform `WorkflowDefinition` so the Behind-the-Scenes `ReadOnlyCanvas` can draw them.
Notes for anyone extending it:

- **It must never throw.** `questionnaireId` and a rule's `targetStepKey` are unmodelled (UG-1) and
  may dangle. A missing questionnaire renders "may have been deleted"; a rule pointing at a
  nonexistent step key gets an explicit **Unresolved target** node, which surfaces an authoring
  error rather than hiding it. This builder feeds a whole tab — a throw takes the page out.
- **Three questionnaire states, not two.** No pointer set = half-authored; pointer set but
  unresolvable = deleted. An author needs to tell those apart.
- **No `_layout` is emitted.** BFS auto-layout places nodes, which is the right trade for a graph
  whose shape changes on every edit. Hand-placed coordinates are worth it only for the curated
  explainer diagrams.
- The selector node is typed `route` (not `agent_call`) so each candidate gets its own labelled
  output handle; its `_meta.agentSlug` is what keeps the agentic "AI" treatment.
- A facilitated meeting is built as a plain sequence — routing machinery there would invent a fork
  the runtime never makes.

The generic diagrams and worked examples are curated: `workflows/definitions/experience-*.ts` and
`experiences/examples.ts`. **Keep the switcher examples domain-neutral as a set** (triage,
escalating depth, role-branching). It is general-purpose conditional routing; illustrating it with
one commercial scenario narrows what authors imagine it can do.

> **`report` is a vestigial step kind.** It is in `EXPERIENCE_STEP_KINDS`, labelled, and offered in
> the step form for both experience kinds — but **no runtime module reads it**. The run report is
> enqueued from `concludeRun`, and `routableSteps` only ever selects `branch`. The diagram says so
> on the node rather than implying an effect. Either wire it up or remove it from the form; leaving
> it selectable-but-inert is the worst of the three.

## Readiness

`experienceBlockers(view)` returns author-facing sentences; empty means ready. It is **advisory** —
nothing at the schema or API layer enforces it, because an author reorders and retypes mid-edit and
a constraint that fires halfway through authoring is an obstacle rather than a guardrail.

The one hard rule: **deleting a non-draft experience is refused with 409.** The cascade would reach
respondent history. Archive instead.

## Reorder contract

`PATCH /:id/steps/reorder` takes the **complete** ordered id list and rejects anything that is not
exactly the current step set — duplicates 400, foreign ids 400, a size mismatch 409. A stale page
therefore fails loudly instead of writing an order derived from a set that no longer exists.

Do not "improve" this into a moved-item delta: two concurrent drags would interleave into an order
neither author chose.

## Step keys

`deriveStepKey` slugifies the title and suffixes `-2`, `-3`, … until free, because two steps
legitimately share a title in a long journey. The derivation is **racy by design** —
`@@unique([experienceId, key])` is the real arbiter and the route maps P2002 to a 409. Keys are how
the routing selector names its choice, so they must survive an LLM prompt round-trip unambiguously:
lowercase kebab, validated by regex on explicit input.

## Gotchas

**Migrations need hand-stripping.** Prisma's diff engine cannot see the raw-SQL pgvector/tsvector
indexes, so every autogenerated Experience migration proposes dropping all five plus a generated
default on `ai_knowledge_chunk`. Generate with `--create-only`, strip those statements, apply with
`migrate deploy`, then verify the five indexes still exist. The schema test guards this.

**`z.coerce.number()` breaks `zodResolver`.** Coercion widens the schema's _input_ type to
`unknown`, which no longer satisfies react-hook-form's form-values generic. Use plain `z.number()`
with `register(..., { valueAsNumber: true })`.

**Restart the dev server after a migration.** A running `npm run dev` holds a stale Prisma client,
and Next 16 blocks a second dev server.

## AI run provenance

Experience LLM calls record an `AppAiRun` with `subjectKind: 'experience_run'` and one of
`experience_routing` / `experience_handoff` / `experience_report`. Routing records **every**
decision, including deterministic rule and fallback outcomes — "why did this respondent get that
questionnaire" is a question an admin will ask months later, and a rule-based answer is as worth
defending as an LLM one.

## Related

- `.context/app/questionnaire/experience-continuity.md` — the respondent journey, addressing, credential
- `.context/app/questionnaire/experience-reports.md` — per-step reports and why scoping is per step
- `.context/app/questionnaire/experience-meetings.md` — facilitated meetings, the breakout clock, rooms
- `.context/app/planning/features/f15.1.md` — foundation decisions and what shipped
- `.context/app/questionnaire/cohorts.md` — the roster an experience may reuse
- `.context/app/questionnaire/round-context-and-learning.md` — the k-anonymity precedent
- `.context/app/questionnaire/ai-run-provenance.md` — the run-capture contract
- `.context/app/planning/features/f15-followups.md` — everything still open across P15
