# Agent Settings

Admin surface to review and tune the questionnaire agents' **model / temperature /
maxTokens / reasoning-effort** against a deterministic task-fit baseline, with cost
trade-offs and one-click apply. ConQuest defaults to **OpenAI**.

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

## How a recommendation is decided

Two questions, in this order, and nothing else:

1. **How much thinking does the task need?** Quality that depends on sustained
   analysis over a lot of material (reading a document into structure, judging a
   design, synthesising a report) → the reasoning tier. A short, well-specified job
   (phrasing a question, pulling a typed value from a reply, formatting prose,
   reading a screenshot) → the chat tier. A mechanical high-frequency chore →
   routing.
2. **Who is waiting?** On the per-turn path a respondent sits watching for a reply,
   so latency is part of quality. Background work has no such constraint, so depth
   is close to free there.

Temperature, maxTokens and effort then follow the task: latitude, largest realistic
output, and how much deliberation the work rewards.

**Which parameters a model happens to read is never a reason to pick it.** The
engine still reports `temperatureIgnored` (an agent setting a temperature its
resolved model does not read) as a housekeeping flag on the card, but it does not
feed any recommendation, and the AI advisor is explicitly told not to argue from it.

## The two layers

The model lives at the **task-tier** level (agents inherit it), so model changes
apply to the shared default; temperature/effort are **per-agent**.

| Layer                                                     | What it shows                                                                                               | Apply target                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Task-tier defaults** (reasoning / chat / routing cards) | current shared default model vs recommended OpenAI model + `$/M`                                            | `PATCH …/orchestration/settings` `{ defaultModels: { [tier]: model } }` — partial-merge, moves every inheriting agent    |
| **Per-agent cards**                                       | current vs recommended temperature / maxTokens / reasoning effort, resolved model, cost delta, 30-day spend | `PATCH …/orchestration/agents/:id` (`updateAgentSchema`) — plus the tier PATCH above when the model change is tier-level |

Infra defaults (embeddings / audio) are shown read-only with a pointer to
Settings → Default models (their PATCH carries extra known-model validation).

## The deterministic engine

`lib/app/questionnaire/agent-advisory/`:

- **`recommendations.ts`** — the curated table (pure data). `TASK_TIER_RECOMMENDATIONS`
  (reasoning→`gpt-5.4`, chat→`gpt-4o`, routing→`gpt-4.1-nano`) and
  `AGENT_RECOMMENDATIONS`: every app agent (slug → tier, temperature, maxTokens,
  effort, rationale), which is 35 named agents plus the 15 design-time judges. The
  judges are **derived from their dimension registries**
  (`evaluation` / `scope-evaluation` / `policy-evaluation` `dimensions.ts`), so a new
  dimension appears on the page automatically; they carry a `panel` label and render
  in their own section. Exactly one agent carries an `overrideModel` — the
  Conditional Topics candidacy check (`gpt-5.4-mini`), whose triage read needs more
  than the summarisation default and far less than the analyst that follows it.
- **`evaluate.ts`** — `evaluateAgentSettings()`: resolves each agent's model
  (explicit → tier default), looks up blended `$/M` from the `AiProviderModel`
  rows, computes a maxTokens-bounded per-call estimate + delta, pulls 30-day
  actuals from `getCostBreakdown`, and emits `isOptimal` plus flags.

**Coverage is test-enforced.** `recommendations.test.ts` parses the app's own
`*_AGENT_SLUG` constants and fails if any declared agent has no recommendation, and
checks every judge in the three panels — so a new agent cannot quietly go
unadvised.

**What "Accept recommended" applies.** Everything the card shows, model included.
Temperature / maxTokens / effort PATCH the agent row. The model lands on the agent
(a pin) when the recommendation is an explicit override or the agent already carries
a pinned model; otherwise it PATCHes that agent's **tier default**, which moves every
agent inheriting that tier — the caveat on the model row says which. Apply-all fixes
the tier defaults first, then the agents, so a tier is never PATCHed twice.

## Hybrid "Explain with AI"

On-demand per agent (the deterministic baseline is always shown first):

- **Agent** `app-agent-settings-advisor` (seed `058-agent-settings-advisor.ts`),
  runtime-resolved, internal, budget-capped — and itself covered by the table.
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
  belong on the tier default so inheritance is preserved. Pin a model
  (`overrideModel`) only when an agent's job genuinely differs from the rest of its
  tier, as the candidacy check's does.
- **Don't argue from parameter support.** "This model ignores temperature" is not a
  reason to move an agent to another model — task fit, latency and cost are. Keep
  that out of the rationales and out of the advisor prompt.
- **Don't send the whole `defaultModels` map on a tier apply.** The settings PATCH
  merges a partial `{ [tier]: model }` — sending the full map risks clobbering.
- **Don't tune temperature on a reasoning-profile model expecting an effect** — it
  isn't read; the card flags it. That's a housekeeping note, not a model verdict.
- **Bare floating model aliases** (`gpt-5.4`), not dated pins. Minor versions are
  distinct ids that do **not** auto-upgrade — bump deliberately and re-verify cost.

## Tests

`tests/unit/lib/app/questionnaire/agent-advisory/{recommendations,evaluate,explain-schema}.test.ts`,
`tests/unit/components/admin/questionnaires/agent-settings/format.test.ts`,
`tests/unit/app/api/v1/app/questionnaires/agent-settings-routes.test.ts`.
