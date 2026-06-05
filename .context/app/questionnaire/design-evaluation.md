# Design-time evaluation (F5.1)

Before a questionnaire is launched, is its **structure** any good? F5.1 stands up a
panel of seven LLM **judges** that read a version's authored design — its goal,
audience, sections, and questions — and score it across distinct dimensions, each
emitting **actionable findings** (concrete proposed edits). This is the first slice of
P5; F5.2 persists runs and F5.3 turns findings into a review queue (accept / decline /
edit / apply).

Unlike the P4 conversational engine there is no respondent and no session — the judges
grade an artefact that already exists. F5.1 ships the judges, the dispatch capability,
and a **no-persistence preview route**; it stores nothing.

## The seven dimensions

| Dimension        | Judge slug                               | Scores                                                                                     |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `clarity`        | `app-questionnaire-judge-clarity`        | Unambiguous, single-barrelled, right reading level                                         |
| `coverage`       | `app-questionnaire-judge-coverage`       | The goal is fully covered — flags **gaps** (what's missing)                                |
| `duplicates`     | `app-questionnaire-judge-duplicates`     | Questions are distinct — flags redundancy                                                  |
| `type_fit`       | `app-questionnaire-judge-type-fit`       | Each question's answer type suits what it asks                                             |
| `ordering`       | `app-questionnaire-judge-ordering`       | Logical flow; sensitive questions placed considerately                                     |
| `audience_match` | `app-questionnaire-judge-audience-match` | Register / burden / assumptions fit the stated audience                                    |
| `goal_match`     | `app-questionnaire-judge-goal-match`     | Every question earns its place — flags **off-mission** questions (the inverse of coverage) |

The dimension → slug/label/summary registry is the single source of truth in
`lib/app/questionnaire/evaluation/dimensions.ts`, shared by the seed, the prompt
builder, and the route.

## Architecture: app-native dispatch, not the eval worker

The judges are dispatched **app-natively** — one structured `runStructuredCompletion`
call per dimension via the `evaluate-structure` capability — exactly like F4.2–F4.5,
**not** through Sunrise's dataset-driven `AiEvaluationRun` worker. That worker grades a
_subject's generated output over a dataset of cases_; here the artefact already exists
and the judges must emit _suggestions_, not a bare 0–1 score. (The plan's original F5.2
sketch named `AiEvaluationRun`; this is a deliberate divergence — see the development-plan
decisions log.)

The judges are still seeded as `kind = 'judge'` agents so they appear in the platform
Judges surface and reuse the agent resolver / cost / admin-edit machinery — but their
**rubric lives in code** (`evaluation/judge-prompt.ts`), not in the agent row, the same
split F4.5's completion agent uses. Tuning a judge is a reviewed, git-diffable code
change; the seeded `systemInstructions` are a self-describing mirror only.

## The pieces

Pure core — `lib/app/questionnaire/evaluation/` (Prisma-free, the F4 discipline):

- `types.ts` — `EVALUATION_DIMENSIONS`, `FINDING_SEVERITIES`, `JudgeFinding`,
  `JudgeVerdict`, and the `VersionStructureInput` DTO the judges read.
- `dimensions.ts` — the dimension registry (`EVALUATION_DIMENSION_SPECS`,
  `EVALUATION_JUDGE_SLUGS`, `dimensionForSlug`).
- `judge-schema.ts` — the Zod output contract (`validateJudgeVerdict`,
  `judgeVerdictJsonSchema`, `MAX_FINDINGS_PER_JUDGE`). `dimension` is **not** in the
  contract — the caller stamps it so a judge can't mislabel its own verdict.
- `structure-schema.ts` — the Zod shape of `VersionStructureInput`, shared by the
  capability (its `structure` arg) and the route loader (validates the stored audience
  JSON via `parseAudienceShape`).
- `judge-prompt.ts` — per-dimension rubrics (focus + anchored 0–1 scale + explicit
  IGNORE clause) + the structure serialiser + the retry message.

Capability — `lib/app/questionnaire/capabilities/evaluate-structure.ts`. A
`BaseCapability` running one judge for one dimension: resolve the judge's binding
(`reasoning` tier) → build the prompt → `runStructuredCompletion` (parse → retry-once →
cost-sum) → stamp the dimension → return the `JudgeVerdict`. `processesPii = false`
(goal/audience/questions are admin-authored content, not respondent data). Registered in
`lib/app/capabilities.ts`.

Route — `POST /api/v1/app/questionnaires/:id/versions/:vid/evaluate-preview`. Loads the
version structure (`_lib/evaluation-structure.ts`), loads the requested judge agents in
one query, and **fans out concurrently**, one dispatch per dimension.

```
POST …/evaluate-preview
  body: { dimensions?: EvaluationDimension[] }   // default: all seven
  → { results: [{ dimension, verdict?, diagnostic? }],
      summary: { dimensionsRequested, dimensionsRun, dimensionsFailed, totalFindings } }
```

## Findings contract

Each judge returns `{ score: 0–1, findings: JudgeFinding[] }`. A finding addresses its
target by `targetKey`: a question's stable `key`, `section:<title>`, or the literal
`goal` / `audience`. A clean dimension yields an **empty** findings array — a valid,
useful result. `severity` is `info | minor | major`. These findings are what F5.3's
review queue will become; `targetKey` is a free string reconciled fail-cleanly at apply
time (the pure core has no live graph), the F2.3 revert-planner posture.

## Gating & limits

- Master flag `APP_QUESTIONNAIRES_ENABLED` **and** sub-flag
  `APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED` (seeded **off**). Either off → **404**.
  Unlike completion, the whole route is paid LLM work, so there is no free deterministic
  half to return when the sub-flag is off.
- Per-admin sub-cap `designEvaluationLimiter` (20 runs/min): one run is seven judge
  calls, the most expensive questionnaire sub-flow per request.
- **Fail-soft per judge**: a dimension whose judge errors or is unseeded returns a
  `diagnostic` instead of a verdict; the other six still return. Only _zero_ judges
  seeded is a 404 (`run db:seed`).

## Seeds

- `018-design-evaluation-judges.ts` — the seven `kind='judge'` agents (`isSystem: false`,
  app-owned, `restricted` KB, `internal` visibility, `temperature 0.2`), via a registry
  loop. Re-seed re-asserts only `kind`/`isSystem` (never clobbers operator edits).
- `019-design-evaluation-flag.ts` — the sub-flag, disabled by default.
- `020-design-evaluation-capability.ts` — the `app_evaluate_structure` `AiCapability`
  row. **Not** bound to any one agent — it's dispatched against a different judge each
  call, so there is no `aiAgentCapability` row.

No migration — F5.1 adds no schema (persistence is F5.2).

## Not in F5.1

Run + suggestion persistence and run history (F5.2); the suggestion review queue with
accept/decline/edit/apply and stale-suggestion derivation (F5.3); any admin UI.
