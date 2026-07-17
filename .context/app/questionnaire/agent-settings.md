# Agent Settings Evaluation

Admin surface to review and tune the questionnaire agents' **model / temperature /
maxTokens / reasoning-effort** against a deterministic cost/performance baseline,
with cost trade-offs and one-click apply. ConQuest defaults to **OpenAI**.

- **Page:** `/admin/questionnaires/agent-settings` (nav: Questionnaires → Agent settings)
- **API:** `GET /api/v1/app/questionnaires/agent-settings` (evaluation),
  `POST …/agent-settings/explain` (AI explain)
- **Flag:** none — always on (admin-only).

## Why this exists

Every questionnaire agent ships with an **empty `model`/`provider`** and resolves
at runtime from the per-task-tier defaults
(`resolveAgentProviderAndModel(agent, task)` → `getDefaultModelForTask(task)` →
`AiOrchestrationSettings.defaultModels[task]`). There was no surface to see what
each agent actually runs, whether it's a sensible cost/quality choice, or to
change it. This adds that surface plus a curated recommendation set.

## The two layers

The model lives at the **task-tier** level (agents inherit it), so model changes
apply to the shared default; temperature/effort are **per-agent**.

| Layer                                                     | What it shows                                                                                               | Apply target                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Task-tier defaults** (reasoning / chat / routing cards) | current shared default model vs recommended OpenAI model + `$/M`                                            | `PATCH …/orchestration/settings` `{ defaultModels: { [tier]: model } }` — partial-merge, moves every inheriting agent |
| **Per-agent cards**                                       | current vs recommended temperature / maxTokens / reasoning effort, resolved model, cost delta, 30-day spend | `PATCH …/orchestration/agents/:id` (`updateAgentSchema`)                                                              |

Infra defaults (embeddings / audio) are shown read-only with a pointer to
Settings → Default models (their PATCH carries extra known-model validation).

## The deterministic engine

`lib/app/questionnaire/agent-advisory/`:

- **`recommendations.ts`** — the curated table (pure data). `TASK_TIER_RECOMMENDATIONS`
  (reasoning→`gpt-5.4`, chat→`gpt-5.4-mini`, routing→`gpt-4.1-nano`) and
  `AGENT_RECOMMENDATIONS` (16 agents: slug → tier, temperature, maxTokens, effort,
  rationale). Only the three trivial hot-path outliers (selector, interviewer,
  completion) carry an `overrideModel` (`gpt-5.4-nano`) — a per-agent pin, not a
  tier change.
- **`evaluate.ts`** — `evaluateAgentSettings()`: resolves each agent's model
  (explicit → tier default), looks up blended `$/M` from the `AiProviderModel`
  rows, computes a maxTokens-bounded per-call estimate + delta, pulls 30-day
  actuals from `getCostBreakdown`, and emits `isOptimal` plus flags.

**Temperature caveat (load-bearing).** The GPT-5 family uses the
`openai-reasoning` param profile and **ignores `temperature`**. The engine flags
`temperatureIgnored` when an agent sets a temperature its resolved model won't
honour — surfaced on the card so operators don't tune a no-op.

## Hybrid "Explain with AI"

On-demand per agent (the deterministic baseline is always shown first):

- **Agent** `app-agent-settings-advisor` (seed `058-agent-settings-advisor.ts`),
  runtime-resolved, internal, budget-capped.
- **Orchestrator** `explain.ts` → `explainAgentSettings(slug)`: one
  `runStructuredCompletion` (reasoning tier) producing `{ narrative, suggestion }`
  (schema in `explain-schema.ts`; an all-null suggestion collapses to `null`).
  Returns a discriminated result (never throws); `logCost` once.
- **Route** `POST …/agent-settings/explain` — admin-only, per-admin sub-cap
  (`settingsAdvisorLimiter`, 20/min). The suggestion applies through the same
  per-agent PATCH.

## Pre-seeded OpenAI defaults (the boot-correct path)

- `prisma/seeds/009-provider-models.ts` — OpenAI rows for `gpt-5.5`, `gpt-5.4`,
  `gpt-5.1`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-4.1-nano`, `gpt-4o-transcribe`
  (blended `costPerMillionTokens`; gpt-5 family `paramProfile: 'openai-reasoning'`).
- `prisma/seeds/020-orchestration-default-models.ts` — pre-sets
  `AiOrchestrationSettings.defaultModels` to OpenAI ids + `activeEmbeddingModelId`.
  **Non-clobbering**: only fills empty slots, so operator edits always win.

**Runtime dependency:** these ids only resolve to OpenAI once an OpenAI
`AiProviderConfig` is active (`OPENAI_API_KEY` set) — provider configs are
operator-managed (no provider seed). `agent-resolver` picks the first active
provider, then this id.

## Anti-patterns

- **Don't recommend a per-agent model for a non-outlier.** Model recommendations
  belong on the tier default so inheritance is preserved. Only pin a model
  (`overrideModel`) for the trivial nano outliers.
- **Don't send the whole `defaultModels` map on a tier apply.** The settings PATCH
  merges a partial `{ [tier]: model }` — sending the full map risks clobbering.
- **Don't tune temperature on a gpt-5 model expecting an effect** — it's ignored;
  the card flags it.
- **Bare floating model aliases** (`gpt-5.4`), not dated pins. Minor versions are
  distinct ids that do **not** auto-upgrade — bump deliberately and re-verify cost.

## Tests

`tests/unit/lib/app/questionnaire/agent-advisory/{recommendations,evaluate,explain-schema}.test.ts`,
`tests/unit/components/admin/questionnaires/agent-settings/format.test.ts`,
`tests/unit/app/api/v1/app/questionnaires/agent-settings-routes.test.ts`.
