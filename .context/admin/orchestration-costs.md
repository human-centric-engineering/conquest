# Costs & Budget dashboard

Admin page at `/admin/orchestration/costs`. Surfaces every spend / budget signal the orchestration layer emits and hosts the editable defaults that influence routing and budget enforcement.

**Page shell:** `app/admin/orchestration/costs/page.tsx` — async server component.
**Client island:** `components/admin/orchestration/costs/costs-view.tsx`.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Summary cards  ·  Today │ Week │ Month │ Projected              │
├─────────────────────────────────────────────────────────────────┤
│ Budget alerts list  (global cap banner + agents ≥ 80%)           │
├─────────────────────────────────────────────────────────────────┤
│ 30-day trend chart  (stacked Area by tier)                      │
├──────────────────────────────┬──────────────────────────────────┤
│ Per-agent spend table        │ Per-model breakdown table        │
├──────────────────────────────┴──────────────────────────────────┤
│ Local vs cloud panel  (pie + savings callout)                   │
├─────────────────────────────────────────────────────────────────┤
│ Pricing reference  (collapsible — model rates, source, synced)  │
├─────────────────────────────────────────────────────────────────┤
│ How costs are calculated  (measured vs est, tokenomics, guides) │
├─────────────────────────────────────────────────────────────────┤
│ Footer link → Settings  (default models + global monthly cap)   │
└─────────────────────────────────────────────────────────────────┘
```

The default-models form and global monthly cap used to live on this page; they were moved to the dedicated Settings page (`/admin/orchestration/settings`) so the Costs page stays focused on reporting. The footer card on this page is a small pointer with a button-link to Settings — it does not fetch or edit configuration.

## Data sources

The server shell fires four parallel null-safe fetches via `serverFetch()`. Any upstream failure renders an empty state in its section — the page never throws.

| Section                | Endpoint                                                    | Notes                                                  |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Summary cards          | `GET /costs/summary`                                        | `totals.today` / `week` / `month`                      |
| Trend chart (totals)   | `GET /costs/summary` (`trend[]`)                            | Daily total only — tier split synthesised client-side  |
| Trend chart (per-tier) | `GET /costs?groupBy=model&dateFrom=<30d>&dateTo=<today>`    | Rows bucketed to tiers via `/models` on the client     |
| Per-agent table        | `GET /costs/summary` (`byAgent[]`)                          | Joined with `monthlyBudgetUsd` server-side             |
| Per-model table        | `GET /costs/summary` (`byModel[]`) + `GET /models`          | Keyed `provider::modelId` — see below                  |
| Local vs cloud panel   | `GET /costs/summary.localSavings` + `byModel[]` + `/models` | `localSavings: null` → muted placeholder, never throws |
| Budget alerts list     | `GET /costs/alerts`                                         | Returns `{ alerts, globalCap }` — sorted by severity   |

### Per-model rows carry their provider

`byModel[]` rows are `{ model, provider, monthSpend }`, grouped by both columns of
`AiCostLog`. The provider is load-bearing, not decoration: the same bare `modelId`
can exist under several providers in the matrix — `gpt-4o` ships under `openai`
and (inactive) under `microsoft` — so a catalogue lookup keyed on the id alone
resolves to whichever entry was merged last, and `mergeDbModelsWithRegistry`
appends DB-only rows at the end. That is how genuine OpenAI spend came to render
as `microsoft / "GPT-4o (Azure)"`.

Consumers use `buildModelIndex` / `lookupModel`
(`components/admin/orchestration/costs/model-index.ts`), which matches
`provider::modelId` first and falls back to the bare id only for providers absent
from the catalogue. The Provider column shows `row.provider` from the cost log —
the provider that actually billed — not the catalogue entry's own provider field.

The trend chart is the exception: its rows come from `GET /costs?groupBy=model`,
which groups by model alone, so its tier lookup stays bare-id and first-write-wins.
A shared id whose two entries sit in different tiers can still be bucketed to the
wrong wedge there.

Before fetching, the page also calls `refreshFromOpenRouter()` once so the model registry's per-token rates are at most 24 h stale. The call is heavily cached and a no-op on warm pages.

## Trend chart — tier synthesis

`/costs/summary.trend` only returns `{ date, totalCostUsd }` — no tier split. To render the stacked area by tier the page fetches `/costs?groupBy=model&dateFrom=…&dateTo=…` in parallel, buckets each model id to its tier against `/models`, and then distributes each day's total proportionally to the 30-day tier mix.

This is an approximation (a day with a spike in frontier usage still shows the 30-day-average tier split), but it requires no backend changes and degrades gracefully: if the per-model fetch fails, the chart falls back to a single area built from the raw `trend[]` totals.

### Zero-fill for missing days

The API omits days with no spend from the trend response. The `fillZeroDays()` helper in the chart component generates the full 30-day date range and fills gaps with `totalCostUsd: 0`. This prevents the chart from drawing misleading connecting lines across multi-day gaps. If every day has zero spend, the chart shows the "No spend recorded" empty state.

## Local savings methodology

`calculateLocalSavings()` in `lib/orchestration/llm/cost-tracker.ts` reads every `isLocal: true` row from the rolling month window and, per row, prices the same token counts against the cheapest non-local model in the same tier — the savings are (what-you-would-have-paid − 0).

| Value           | Meaning                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tier_fallback` | Substituted with the cheapest non-local model in the reported tier. This is the only reachable mode today — local rows always carry local model ids, so there is never a direct hosted equivalent to match against. |

The `methodology` field is retained as a single-value union on `LocalSavingsResult` so future modes (e.g. `equivalent_hosted` when local models gain a hosted-alias mapping) can be added without a response-shape break.

On any error — registry lookup blew up, Prisma threw, anything — the helper returns `null` and the rest of `getCostSummary()` still renders. The UI shows "—" in the savings callout in that case.

## Defaults & global cap (managed on the Settings page)

The default-model assignments and the global monthly budget cap are edited on `/admin/orchestration/settings` — see [`orchestration-settings.md`](./orchestration-settings.md) for the form itself. This section documents how those values are consumed by the cost/budget runtime, which is the part a Costs reader usually cares about.

### Default model assignments

The Settings form writes per-task defaults to the single `AiOrchestrationSettings` row (`slug: 'global'`, lazily upserted by `GET /settings`). Task slots: `routing` / `chat` / `reasoning` / `embeddings` / `audio`. Saved via `PATCH /settings { defaultModels }`.

Validation lives in `app/api/v1/admin/orchestration/settings/route.ts`:

- chat/routing/reasoning ids are checked via `validateTaskDefaults()` in `model-registry.ts` — each id must resolve through `getModel()` in the chat-model registry.
- the `embeddings` slot is validated separately against the DB-backed embedding-model registry (`getEmbeddingModels()`) because those ids aren't in the synchronous chat registry.
- the `audio` slot is parsed by `parseAudioDefault()` and matched against the available audio models.

Defence-in-depth: bogus ids never reach the DB, even if a non-form caller PATCHes the endpoint directly.

At runtime, values resolve via `getDefaultModelForTask(task)` in `lib/orchestration/llm/settings-resolver.ts`, called whenever the chat handler needs a model for a task the agent has not explicitly overridden. A 30-second in-memory TTL cache sits in front of the Prisma read; PATCH calls `invalidateSettingsCache()` so the next chat turn picks up the change immediately.

### Global monthly budget cap — enforcement

When the cap is set on the Settings page, `cost-tracker.ts#checkBudget()` additionally computes the month-to-date spend _across all agents_ via `getMonthToDateGlobalSpend()` and flips `globalCapExceeded: true` when the cumulative total is at or above the cap.

The streaming chat handler treats this the same as a per-agent budget breach: it emits the shared `budget_exceeded` SSE error code (`lib/orchestration/chat/streaming-handler.ts:396-399`) with a generic "monthly budget reached" message, and dispatches the `budget_exceeded` webhook. There is **no distinct error code for the global cap** — the UI's red "Global monthly budget exceeded" banner is driven by `GET /costs/alerts → globalCap.exceeded`, not by SSE frame discrimination.

The global cap enforcement is wrapped in try/catch so a transient settings fetch failure degrades gracefully to the per-agent path — it never blocks chat globally because Prisma hiccuped.

### Per-turn cost cap

A separate mechanism caps the cost of a single chat turn (defense against a tool loop that fails to converge). Two layers:

- **Per-agent override** — `AiAgent.maxCostPerTurnUsd`, edited on the agent form. See [`agent-form.md`](./agent-form.md#per-turn-cost-cap-usd).
- **Org default** — `AiOrchestrationSettings.defaultMaxCostPerTurnUsd`, edited on the Settings page. Applies when an agent leaves its own cap blank.

When the accumulating turn cost crosses the resolved cap mid-loop, the streaming handler emits a distinct `budget_exceeded_per_turn` SSE event (separate from the monthly `budget_exceeded` code), persists the partial assistant message with `endedReason: 'budget_exceeded'`, and dispatches the `chat_budget_exceeded_per_turn` webhook so PagerDuty/alerting can fire independently of the monthly-overrun signal. See [`.context/orchestration/chat.md`](../orchestration/chat.md) for the loop semantics; the `agent_call` workflow step type mirrors the same guard with the `agent_call_budget_exceeded_per_turn` error.

## Global cap exceeded banner

When the platform-wide monthly budget cap is exceeded, `BudgetAlertsList` renders a prominent red banner at the top of the alerts section showing the current spend vs cap (e.g. "$542.00 of $500.00") with a link to `/admin/orchestration/settings`. This is driven by `globalCap: GlobalCapStatus` returned alongside per-agent alerts from `GET /costs/alerts`. The `GlobalCapStatus` shape is `{ cap: number | null, spent: number, exceeded: boolean }`, produced by `getGlobalCapStatus()` in `cost-reports.ts`.

## Pause-agent flow

`BudgetAlertsList` (client island, distinct from the dashboard's `BudgetAlertsBanner`) renders two actions per alert row:

1. **Adjust budget** — `<Link>` to `/admin/orchestration/agents/:id`.
2. **Pause agent** — `apiClient.patch('/agents/:id', { isActive: false })` with optimistic update. The row is marked paused immediately; on failure the state reverts and an inline error banner surfaces the reason. No new endpoint is introduced — the existing admin `PATCH /agents/:id` handles this and is already admin-guarded and rate-limited.

## Type naming

Two `CostSummary`-like types exist, deliberately named differently:

| Type               | Module                                  | Usage                                                                  |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------- |
| `CostSummary`      | `lib/orchestration/llm/cost-reports.ts` | Dashboard-level totals/byAgent/byModel/trend/localSavings              |
| `AgentCostSummary` | `types/orchestration.ts`                | Per-agent breakdown with raw entries array (used by `getAgentCosts()`) |

## Pricing reference panel

`PricingReference` — collapsible card (starts collapsed) showing the per-model token rates used to calculate spend figures.

**Data source:** `/models` endpoint now returns `fetchedAt` (epoch ms) alongside the model list. The server shell passes both `models` and `registryFetchedAt` to the client island.

**Content when expanded:**

- Per-model table: name, provider, tier, input rate, output rate, source badge
- Source badge: "Live" (OpenRouter feed active, refreshed every 24h) or "Fallback" (static hardcoded rates, used when OpenRouter is unreachable)
- "Last synced" relative timestamp in the header (e.g. "2h ago", "Never (using static fallback)")
- Explainer text on rate meaning and typical token consumption

**Pricing source pipeline:** Static fallback map (compiled in) → OpenRouter `/api/v1/models` (24h cache, Zod-validated) → per-provider discovery (marks `available: true`). The cost tracker multiplies actual token counts by these rates.

**OpenRouter refresh on page load:** The costs page calls `refreshFromOpenRouter()` before rendering, ensuring current-rate data is never more than 24h stale (no-op when cache is warm). Failures are negative-cached for 5 minutes — when OpenRouter is unreachable, subsequent calls inside that window short-circuit without re-issuing the (10-second timeout) fetch, so a remote outage doesn't compound into per-page-load slowdowns. After 5 minutes the next call retries; `force: true` bypasses both caches.

## Cost methodology panel

`CostMethodology` — always-visible educational section explaining how costs are calculated and what the numbers mean.

**Sections:**

1. **Measured vs Estimated** — two-column card distinguishing exact data (token counts, model attribution, timestamps) from approximations (per-token rates, tier breakdown, projections).
2. **Tokenomics education** — explains tokens, input vs output pricing asymmetry, industry trends (falling prices, output-heavy costs, context length impact, local models).
3. **Quick cost guide** — table of common use cases (classification, chat, RAG, reasoning, summarization) with recommended tier and typical cost-per-request range.
4. **Workflow cost estimation** — simple/complex workflow cost ranges with the tip to use budget-tier for structured tasks.

## Workflow template cost indicator

The `TemplateBanner` in the workflow builder now shows an estimated cost-per-run badge when `workflowDefinition` is provided. The estimate counts LLM-consuming step types (`llm_call`, `chain`, `reflect`, `evaluate`, `plan`, `route`, `agent_call`) and multiplies by a per-step cost range from budget-tier ($0.002/step) to frontier-tier ($0.05/step).

The badge format is `$low–$high/run` and includes a tooltip explaining the methodology. Workflows with no LLM steps show no badge.

## Cross-references

- [`.context/admin/orchestration-settings.md`](./orchestration-settings.md) — where default models and the global monthly cap are edited
- [`.context/admin/agent-form.md`](./agent-form.md) — per-agent monthly budget and per-turn cost cap fields
- [`.context/admin/provider-form.md`](./provider-form.md) — where API keys live
- [`.context/admin/workflow-builder.md`](./workflow-builder.md) — template banner, cost indicator
- [`.context/orchestration/chat.md`](../orchestration/chat.md) — streaming handler loop, budget enforcement semantics
- [`.context/orchestration/cost-estimation.md`](../orchestration/cost-estimation.md) — pre-run USD estimate service (empirical + heuristic)
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — `/settings`, `/costs`, `/costs/summary`, `/costs/alerts`
- [`.context/orchestration/llm-providers.md`](../orchestration/llm-providers.md) — `getDefaultModelForTask` in `settings-resolver.ts`
- [`.context/api/orchestration-endpoints.md`](../api/orchestration-endpoints.md) — consumer HTTP reference
