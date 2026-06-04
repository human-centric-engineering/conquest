# Questionnaire — pre-launch cost estimation

> A heuristic projection of the LLM spend of running respondents through a
> questionnaire version, surfaced to the admin **before launch** so they can size
> the cost budget and decide whether to proceed. Built by **F3.3**
> ([`../planning/features/f3.3.md`](../planning/features/f3.3.md)) — the third
> feature of P3. Gated by `APP_QUESTIONNAIRES_ENABLED` (404 when off). Reads the
> F3.1 config and prices through Sunrise's provider-agnostic model registry.

## What it does

F3.1 lets an admin set a per-session `costBudgetUsd` cap, but blind — there was no
way to see expected spend. F3.3 fills that gap: a read-only estimate of the cost of
one respondent's conversational session, scaled to an expected respondent count for
a per-questionnaire figure, shown in the config editor and on the invitations page.

It does **not** spend anything, mutate anything, or call an LLM — it is pure math
over the version's questions, the saved config, and the registry's pricing.

## Why it is heuristic-only

The conversational session/turn engine (P4/P6) does not exist yet, so there are
**zero real session runs** to calibrate against. The estimate is therefore
`basedOn: 'heuristic'` always — there is no empirical mode. The copy says so, and
the range is deliberately wide. When P6 lands and starts logging per-turn token
actuals on `AppQuestionnaireTurn`, a future PR can add an empirical mode keyed on
those (mirroring `lib/orchestration/cost-estimation/workflow-cost.ts`, which flips
empirical once ≥3 matching past runs exist).

## The model

One respondent's session is modelled as a sequence of **turns**, one per asked
question. The dominant cost driver is the **conversation history**: every turn
re-sends the transcript so far, so input tokens grow **quadratically** with the
number of questions asked.

Let `Q` = effective questions asked per session (see below). With constants from
`lib/app/questionnaire/cost-estimation/types.ts`:

```
inputTokensPerSession  = Q × (SYSTEM_PROMPT_TOKENS + avgQuestionPromptTokens)
                         + HISTORY_TOKENS_PER_PRIOR_TURN × Q(Q−1)/2
outputTokensPerSession = Q × OUTPUT_TOKENS_PER_TURN

midUsd  = inputTokensPerSession/1e6 × inputCostPerMillion
        + outputTokensPerSession/1e6 × outputCostPerMillion
lowUsd  = midUsd × RANGE_LOW_FACTOR     (0.5)
highUsd = midUsd × RANGE_HIGH_FACTOR    (1.7)

perQuestionnaire = perSession × respondents
```

`avgQuestionPromptTokens` is the sum of `estimateTokens(slot.prompt)` over the
version's slots, divided by the question count — the real question text, sized by
Sunrise's per-provider tokeniser, charged once per asked turn.

| Constant                                 | Value     | Meaning                                         |
| ---------------------------------------- | --------- | ----------------------------------------------- |
| `SYSTEM_PROMPT_TOKENS`                   | 1500      | Agent instructions re-sent every turn           |
| `HISTORY_TOKENS_PER_PRIOR_TURN`          | 250       | Each prior Q+A replayed in a later turn's input |
| `OUTPUT_TOKENS_PER_TURN`                 | 400       | Agent reply + structured answer extraction      |
| `RANGE_LOW_FACTOR` / `RANGE_HIGH_FACTOR` | 0.5 / 1.7 | Heuristic uncertainty band                      |

These are **conservative, tunable assumptions, not measured values.**

### Effective questions per session (`Q`)

`Q` honours the F3.1 config caps:

```
Q = max( min(questionCount, maxQuestionsPerSession ?? questionCount),
         min(minQuestionsAnswered, questionCount) )
```

i.e. cap to `maxQuestionsPerSession` (if set), but never below the completion floor
`minQuestionsAnswered`, and never above the number of questions that actually exist.
`Q = 0` (no questions) yields an all-zero estimate with an explanatory note.

## Provider-agnostic pricing & the unknown-price contract

The model is resolved via `getDefaultModelForTaskOrNull('chat')` (the org default
chat model in `AiOrchestrationSettings.defaultModels.chat`), falling back to a
last-resort slug in cold-start deployments. Pricing comes from `getModel(slug)` in
the registry — no vendor lock.

When the resolved model has **no registry price** (`getModel` returns `undefined`,
or its rate is `0`), the estimate returns `pricingKnown: false` with USD fields at
`0` and a note explaining the missing price. **A registry $0 is treated as
"unknown", not "free"** — the UI shows "pricing not configured for <model>" rather
than a misleading `$0.00`. Token volume is still estimated in this case.

## The endpoint

```
GET /api/v1/app/questionnaires/:id/versions/:vid/cost-estimate?respondents=N
```

`withAdminAuth`, flag-gated (404 when off), read-only. `respondents` is optional
(default `1`, `1..10000`). Returns a `SessionCostEstimate`:

```jsonc
{
  "perSession": { "lowUsd": 0.01, "midUsd": 0.02, "highUsd": 0.04 },
  "perQuestionnaire": { "lowUsd": 0.5, "midUsd": 1.1, "highUsd": 1.9 },
  "respondents": 50,
  "basedOn": "heuristic",
  "pricingKnown": true,
  "model": "claude-sonnet-4-6",
  "assumptions": {
    "questionCount": 12,
    "effectiveQuestionsPerSession": 12,
    "inputTokensPerSession": 38500,
    "outputTokensPerSession": 4800,
    "inputCostPerMillion": 3,
    "outputCostPerMillion": 15,
  },
  "notes": "Heuristic estimate over 12 questions per session …",
}
```

No audit row, no rate-limit sub-cap (pure math, no LLM call — inherits the section
100/min). Registered as `API.APP.QUESTIONNAIRES.versionCostEstimate(id, vid)`.

## Where it shows

Both surfaces fetch the estimate once (`?respondents=1`) and scale the
per-questionnaire figure client-side as the admin changes the respondent count —
`perQuestionnaire = perSession × respondents` is pure multiplication, so one GET per
surface suffices (no refetch per keystroke). Shared component:
`components/admin/questionnaires/cost-estimate-card.tsx`.

- **Config editor** (`config-editor.tsx`, `variant="card"`) — under the Budget &
  caps block. Shows the per-session range, an expected-respondents input → total,
  and an amber **over-budget note** when the per-session mid exceeds the live
  (possibly unsaved) `costBudgetUsd`. Re-fetches after a config save (the saved
  cap/floor change `Q`).
- **Invitations page** (`variant="banner"`) — a one-line read-out above the invite
  form, so the cost is visible at the actual invite moment.

## Code map

| Concern                          | Path                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Pure estimator + types/constants | `lib/app/questionnaire/cost-estimation/`                                      |
| Route                            | `app/api/v1/app/questionnaires/[id]/versions/[vid]/cost-estimate/route.ts`    |
| Shared UI                        | `components/admin/questionnaires/cost-estimate-card.tsx`                      |
| Pricing lookup (reused)          | `getModel` — `lib/orchestration/llm/model-registry.ts`                        |
| Token sizing (reused)            | `estimateTokens` — `lib/orchestration/chat/token-estimator.ts`                |
| Default chat model (reused)      | `getDefaultModelForTaskOrNull` — `lib/orchestration/llm/settings-resolver.ts` |

## What it is not

- **Not enforcement.** The hard per-session cap (`costBudgetUsd`) is enforced at
  runtime by the turn engine in **F6.3**; F3.3 only _displays_ the estimate vs the
  cap.
- **Not the document-extraction (F1.1) cost.** That is incurred once at ingest and
  logged via `logCost`; it is not part of a forward-looking per-session estimate.
- **Not a quote.** A heuristic band, not a measured price — see _Why it is
  heuristic-only_.
