# AI run provenance

How ConQuest keeps a durable record of the AI runs that judge, verify, and generate the things
admins rely on — and, just as deliberately, which runs it does **not** keep.

Shipped in F14.15. See [`f14.15.md`](../planning/features/f14.15.md) for the audit that produced it.

## The rule

A run is **preserved** when any of these holds:

| Test                                        | Example                                                |
| ------------------------------------------- | ------------------------------------------------------ |
| A human later acts on its verdict           | evaluation findings, critic flags, advisor suggestions |
| It changed durable config                   | anything that mutated a version's structure            |
| You'd need to defend the output to a client | reports, scoring, extraction fidelity                  |
| It's a calibration signal worth a trend     | judge scores, coverage, cost per artifact              |

Everything else is **ephemeral by design**. Preserving interactive previews or mid-workflow control
flow costs storage and adds noise without making a new question answerable.

### Deliberately ephemeral — do not "fix" these

- `evaluate-preview` — the design-eval dry run. The admin is exploring; the real run persists.
- The `judge_call` / `evaluate` / `guard` / `reflect` workflow step executors — control flow,
  already captured in `AiWorkflowExecution.executionTrace`.
- The input and output guards — regex, no LLM call to describe.
- `scripts/eval/extraction.ts` — a dev calibration script, not a product surface.
- Contradiction / abuse / sensitivity detectors — aggregate state on the session is the right
  granularity. Nobody acts on the per-call reasoning.

## `AppAiRun`

One row per captured run. Defined in `prisma/schema/app-questionnaire.prisma`.

Polymorphic by design: `subjectKind` + `subjectId` rather than one nullable FK per subject. The
capturing surfaces span three subject types across two tiers, so per-subject columns would mean six
columns with five always null. Mirrors how `AppQuestionnaireTurnEvaluation` denormalises
`questionnaireVersionId`.

| Group          | Columns                                                |
| -------------- | ------------------------------------------------------ |
| Subject        | `subjectKind`, `subjectId`, `versionId`                |
| Classification | `kind`, `status`                                       |
| Binding        | `provider`, `model` — **resolved**, post-fallback      |
| Snapshots      | `promptSnapshot`, `outputSnapshot`, `truncated`        |
| Spend          | `inputTokens`, `outputTokens`, `costUsd`, `durationMs` |
| Detail         | `detail` (per-kind), `error`                           |
| Version stamp  | `promptVersion`, `appVersion`                          |
| Attribution    | `triggeredByUserId`, `createdAt`                       |

Vocabulary (`APP_AI_RUN_SUBJECTS`, `APP_AI_RUN_KINDS`, `APP_AI_RUN_STATUSES`) lives in
`lib/app/questionnaire/ai-run/types.ts`. Platform references are plain `String` with no FK — the
UG-1 convention, so app→platform relations don't fight upstream syncs.

### Snapshots are capped

`AI_RUN_SNAPSHOT_MAX_CHARS` (20k) bounds each snapshot; `truncateSnapshot` cuts and marks rather
than storing everything or nothing. One pathological run — a 200-question questionnaire inlined
into a critic prompt — would otherwise dominate the table.

Snapshots store the **fully interpolated** prompt, not template + variables. The debugging question
is always "what did the model actually see". (The workflow engine stores the raw template instead,
at `orchestration-engine.ts:1241`, and is harder to debug for it.)

## Writing a run

```ts
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';

void recordAiRun({
  subjectKind: 'version',
  subjectId: versionId,
  versionId,
  kind: 'config_advice',
  provider: agent.provider,
  model: agent.model,
  outputSnapshot: narrative,
  detail: { conflicts, suggestions },
  triggeredByUserId: adminId,
});
```

**`recordAiRun` never throws.** A provenance write must not fail the admin's actual action — losing
a questionnaire edit because its audit row wouldn't insert is strictly worse. Failures log at
`error` with the identifying fields and return `null`.

**But a swallowed failure must never look like success.** If a human is waiting on the result,
check the returned id and tell them. This is the mistake the turn-evaluation route originally
made: it caught the persist failure, returned `evaluationId: null`, and the review UI simply didn't
render — so an admin read a verdict with no idea it had not been saved. That route now returns
`persistError` and the drawer shows it.

The store lives in `lib/`, not the API tier, because both tiers capture runs — the ingest and
advisor routes, and the learning-digest builder, which is itself a `lib/` module.

## What's captured today

| Kind                | Surface               | Why                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extraction_verify` | ingest stream route   | Questions flagged `suspect` but not repaired used to persist looking exactly as clean as confirmed ones. `repairOutcome` distinguishes `repaired` / `repair_failed` / `skipped_systemic` / `verifier_unavailable` — `repair_failed` is set when the repair pass returned zero repairs (unseeded agent, failed dispatch, or throw), so a fail-soft repair can't be filed as a successful one. |
| `config_advice`     | Config Advisor stream | Produced authoritative-reading recommendations and wrote nothing — the route's only DB call was loading the agent.                                                                                                                                                                                                                                                                           |
| `edit_precise`      | edit-agent apply      | Mutates structure but writes **zero** change rows; the only trace was an audit row whose `entityName` was the literal string `"precise"`.                                                                                                                                                                                                                                                    |
| `edit_rewrite`      | edit-agent apply      | Whole-structure replacement; supersedes the change log.                                                                                                                                                                                                                                                                                                                                      |
| `learning_digest`   | `learning/digest.ts`  | The digest table is replaced wholesale each build, so history lived nowhere.                                                                                                                                                                                                                                                                                                                 |

## Extraction change log: superseded, not deleted

`replaceVersionStructure` (`_lib/persist.ts`) used to `deleteMany` the version's
`AppQuestionnaireExtractionChange` rows before rewriting the graph. Reached by **edit-agent
rewrite** and **compose-refine**, it meant one "make it shorter" on an uploaded questionnaire wiped
every `sourceQuote` and `beforeJson` — permanently disabling revert, silently.

Those rows are now flipped to `status: 'superseded'` with a `supersededAt` stamp. They stay
queryable and stay visible in the review table (badged, dimmed, non-revertable). Only `applied`
rows are revert candidates; `reverted` and `superseded` are both terminal.

**Re-ingest still deletes, correctly** (`_lib/reingest.ts`): it replaces the source document, so
the prior extraction's rationale no longer refers to anything. A rewrite keeps the same document.

For a **composed** (brief-authored) questionnaire the change log is `[]` by design, so none of this
applies — the damage was specific to the extract-then-rewrite path.

## Cost attribution

App reasoning calls go through `logAppLlmCost` (`lib/app/questionnaire/llm/log-app-cost.ts`), which
wraps the platform's `logCost`.

Before F14.15 the app had two disjoint spend paths: orchestration-tier calls logged to `AiCostLog`,
while `report/`, `cohort-report/`, `scoring/`, `persona/`, `contradiction/` and `tagging/` called
`getProvider` directly and logged nothing. That spend was invisible to `cost-reports.ts` **and** to
per-agent budget enforcement — so the research-spend cap documented in
`.context/orchestration/report-web-search.md` could not fire.

The wrapper exists rather than calling `logCost` directly for two reasons:

1. `AiCostLog` has only three FK columns (`agentId`, `conversationId`, `workflowExecutionId`), none
   of which is a questionnaire version. App rows must carry `versionId` in `metadata` or they can
   never be joined to the artifact they produced. Requiring it in the signature makes omission
   impossible — previously four of six authoring call sites omitted it.
2. Every call site wants the same fire-and-forget posture, and repeating `.catch(() => {})` a dozen
   times invites one site to get it wrong.

Capabilities are `app_`-prefixed so app spend is separable from platform spend with one filter.

## Retention

App prunes live in `lib/app/questionnaire/retention.ts`, registered as the `appRetention` task in
the maintenance tick. They are **not** an edit to `lib/orchestration/retention.ts` — that file
merges from upstream on every sync.

Covers `AppQuestionnaireTurnEvaluation` (highest-volume: one row per evaluated turn, each with a
full verdict _and_ an input snapshot), `AppQuestionnaireEvaluationRun` (findings cascade), and
`AppAiRun`. All three reuse the platform's `evaluationRetentionDays` — same class of data, and a
fourth operator knob would invite exactly the drift the platform module already warns about.
`null` (default) means keep forever.

Prunes are age-based on `createdAt` and unconditional: unlike executions and eval runs, none of
these models has an in-flight state to protect.

### Known operator hazard

`costLogRetentionDays` must be `>= executionRetentionDays`. `pruneCostLogs` runs independently of
`pruneExecutions`, so a shorter cost window empties the cost drill-down of executions that are
still retained — `totalCostUsd` survives as a scalar while the rows behind it are gone, and summary
and breakdown disagree with no indication why. Documented in both modules; enforced in neither.
Same shape as the existing `evaluationRetentionDays <= executionRetentionDays` note.

## Related

- [`f14.15.md`](../planning/features/f14.15.md) — the audit, the phasing, and what was dismissed
- [`upstream-gaps.md`](../planning/upstream-gaps.md) — UG-12, agent-version pinning
- `.context/orchestration/retention.md` — platform prune windows
- `.context/app/questionnaire/respondent-report.md` — the `methodRecord` pattern this generalises
