# Maintenance cron cadence

Why ConQuest's maintenance cron runs **hourly** while Sunrise's docs recommend
every 60 seconds — and the conditions that would make hourly wrong.

> **Do not "fix" `vercel.json` back to `* * * * *`.** The one-minute cadence is
> Sunrise's recommendation for a persistent-process deployment. It is wrong for
> this app on Neon, for the reasons below.

## The problem

ConQuest runs on Vercel with a **Neon** Postgres. Neon autosuspends its compute
after 5 minutes with no queries and stops billing. `vercel.json` used to call
`/api/v1/cron/maintenance` **every minute**, and `runMaintenanceTick()` fans out
to its tasks unconditionally — no "is there work?" pre-check, no throttling. So
the database never got 5 quiet minutes, never suspended, and billed ~730 h/month
against near-zero real traffic.

The driver is **cadence, not query count**. Autosuspend keys off compute idle
time, so a single query per minute defeats a 5-minute timer just as effectively
as the ~24 an idle tick actually issues. Optimising the tick would save nothing.

## Why hourly is safe here

The tick runs 12 tasks. **Nine of them sweep platform tables that ConQuest's
production data path never populates.** Audited 2026-07-21:

| Task                             | Sweeps                        | ConQuest writes this?               |
| -------------------------------- | ----------------------------- | ----------------------------------- |
| `processDueSchedules`            | `AiWorkflowSchedule`          | No — admin-UI-only, nothing seeded  |
| `processPendingExecutions`       | `AiWorkflowExecution`         | No                                  |
| `processOrphanedExecutions`      | `AiWorkflowExecution`         | No                                  |
| `reapZombieExecutions`           | `AiWorkflowExecution`         | No                                  |
| `processPendingRetries`          | `AiWebhookDelivery`           | No — no subscriptions exist         |
| `processPendingHookRetries`      | `AiEventHookDelivery`         | No — no hooks exist                 |
| `backfillMissingEmbeddings`      | `ai_message`                  | No — permanent no-op, see below     |
| `processPendingEvaluationRuns`   | `AiEvaluationRun`             | No — app evals are different tables |
| `enforceRetentionPolicies`       | platform tables               | Partly — only `AiCostLog`           |
| `processQueuedRespondentReports` | `AppRespondentReport`         | **Yes**                             |
| `processQueuedReportRevisions`   | `AppRespondentReportRevision` | **Yes**                             |
| `enforceAppRetentionPolicies`    | app eval / `AppAiRun` tables  | **Yes**                             |

**ConQuest never runs the workflow engine.** The turn path dispatches
capabilities and direct LLM completions (`_lib/turn-invokers.ts`,
`report/run-report.ts`, `experiences/meeting/synthesise.ts`). What ConQuest calls
a "workflow" is a hand-authored Behind-the-Scenes **diagram**
(`lib/app/questionnaire/workflows/registry.ts`), not an engine DAG.

**ConQuest writes no `AiMessage` rows.** Questionnaire chat persists to the
app-owned `AppQuestionnaireTurn` (`_lib/turns.ts`). `streamChat` — the only
`AiMessage` writer — is called solely from the platform chat, embed and admin
routes. So the embedding backfill scans a table this app never inserts into.

> Two stale comments claim otherwise: `_lib/prompt-catalog.ts` and
> `_lib/turn-invokers.ts` both say the Question Selector runs through
> `streamChat`. It was migrated off it — see `_lib/selector-completion.ts`.

**The three tasks that do matter tolerate hourly:**

- Respondent reports and revisions both **kick their own worker via `after()`**
  at the enqueue site (`submit/route.ts`, `report/retry/route.ts`,
  `report/revisions/route.ts`), so the cron is a pure backstop for a kick that
  was cut off. A respondent whose report stalls gets a "Check again" button that
  re-kicks in seconds.
- App retention is a daily-window prune. Hourly is _better_ than per-minute.

## What this costs

Recovery latency, not correctness. Nothing is dropped — neither retry query has
an age filter or DLQ-by-age, and `exhausted` is computed from attempt count, never
elapsed time.

- A **failed** report kick waits up to an hour (respondent has the re-kick button).
- If an operator uses the **Sunrise admin surfaces** — manually runs a workflow,
  creates a schedule/webhook, launches an eval run, uses the admin chat — those
  tasks acquire real work and inherit up to an hour of latency. Queued eval runs
  are worst: one run per tick, and the worker releases its lease every 45s to
  resume on a later tick, so a multi-tick run stretches to hours.
- The executions list flags anything running over `stuckExecutionThresholdMins`
  (default **5**), so it will show "stuck" rows an hour before anything can act
  on them. Raise that setting if it becomes noisy.

## What would invalidate this

Revisit the cadence if any of these become true:

1. **Any enabled `AiWorkflowSchedule` row with a sub-hourly cron.** These degrade
   **silently** — `getNextRunAt(expr, now)` reschedules from the tick time with no
   catch-up, so a `*/15` schedule fires once an hour and the misses vanish with no
   log line. This is the only place work is genuinely lost rather than delayed.
   Check with:
   ```sql
   SELECT count(*) FROM "AiWorkflowSchedule" WHERE "isEnabled" = true;
   ```
2. **ConQuest starts using the workflow engine, webhooks, event hooks, or
   platform evaluations** for anything in the respondent path.
3. **ConQuest starts writing `AiMessage` rows** (e.g. a surface adopting
   `streamChat`), which makes the 25-rows-per-tick embedding backfill relevant —
   and note it orders newest-first, so a backlog starves from the tail.
4. **Real traffic grows** such that a stalled report waiting up to an hour stops
   being acceptable.

## Related

- Upstream fix tracked as **UG-13** in
  [`../planning/upstream-gaps.md`](../planning/upstream-gaps.md) →
  [sunrise#442](https://github.com/human-centric-engineering/sunrise/issues/442).
- The admin overview's `/api/health` poll (`SELECT 1` every 30s, **no visibility
  gating**) keeps the DB awake from a forgotten browser tab independently of this
  cron. That fix is platform-owned and is part of #442.
- Operator visibility for all of this — what runs on a timer, its purpose, and
  whether it actually ran — is proposed upstream as
  [sunrise#443](https://github.com/human-centric-engineering/sunrise/issues/443).
  Until it lands there is **no admin surface** showing the tick's cadence or
  last run: per-task results go only to the in-memory log buffer, and nothing
  persists a tick history.
- Platform-side scheduling reference: `.context/orchestration/scheduling.md`
  (whose "every 60 seconds" deployment advice this app deliberately departs from).
