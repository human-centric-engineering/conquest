# Report Web-Search Rounds

Optional web-search rounds that bring **live external context** into report generation. An admin configures, per questionnaire version, one or more search rounds that run **before** report generation (to inform the report), **after** it (to enrich / fact-check the finished report), or **both**. A seeded research agent runs the admin's instruction as iterative web searches — each round refining its query from the previous results — and the findings surface in the report as a **table or list of linked sources**, and/or silently inform the report's prose.

Shipped for the **Respondent Report** (report kind `respondent`); the module is report-kind-agnostic, so the **Cohort Report** is an additive follow-up.

## Go-live checklist

To take this feature live in an environment (the feature is inert until all four are done):

1. **Seed** — `npm run db:seed` applies the 3 new seed units: the feature flag (`069`), the Report Research agent (`070`), and the `web_search` capability + agent binding (`071`).
2. **Search backend** — set `BRAVE_SEARCH_API_KEY` and add `api.search.brave.com` to `ORCHESTRATION_ALLOWED_HOSTS` (both in `.env.local`). Until both are set, research is skipped and reports generate normally.
3. **Feature flag** — enable the `APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_ENABLED` feature flag (a `feature_flag` DB row, disabled by default).
4. **Configure & verify** — on a questionnaire version's **Respondent Report → Research** tab, enable rounds and set instructions; complete a session; confirm the "Research & sources" block renders on the completion screen and in the exported PDF.

## Feature gate & configuration

- **Platform flag:** `APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_ENABLED` (`APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG`), a `feature_flag` DB row, **disabled by default**, seeded by `069-report-web-search-flag.ts`. Opt-in on top of `APP_QUESTIONNAIRES_ENABLED` and the report-kind flag.
- **Search backend (required to actually run):** `BRAVE_SEARCH_API_KEY` env var + `api.search.brave.com` in `ORCHESTRATION_ALLOWED_HOSTS`. Until both are set the feature is **inert** — research is skipped and the report generates normally. Same graceful-degradation contract as the provider-model-audit workflow.
- **Per-version config:** the `research` block inside the `respondentReport` JSON column (no migration — it nests in the existing column). Edited from the **Research tab** on the Respondent Report editor (hidden unless the platform flag is on).

The `research` config (`RespondentReportSettings.research`, `lib/app/questionnaire/types.ts`):

| Field                                        | Meaning                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                    | Master toggle for this version's rounds.                                                                                        |
| `timing`                                     | `before` \| `after` \| `both`.                                                                                                  |
| `rounds`                                     | Search calls per phase (1…`MAX_REPORT_RESEARCH_ROUNDS` = 5). Each round builds on the previous.                                 |
| `maxResults`                                 | Results requested per round (1…`MAX_REPORT_RESEARCH_RESULTS` = 10).                                                             |
| `before.instructions` / `after.instructions` | The admin's prompt for each phase — purpose of the search + what to do with the results.                                        |
| `display`                                    | `table` \| `list` \| `hidden` — how findings render in the report.                                                              |
| `informNarrative`                            | Whether `before` findings may inform the grounded report prose (framed as general context, never attributed to the respondent). |

Defensive narrowing lives in `narrowRespondentReportSettings` (`report/settings.ts`); the strict Zod sub-schema is in `authoring/config-schema.ts`.

## The `web_search` capability

`lib/app/questionnaire/capabilities/web-search.ts` — a thin, **provider-agnostic** `BaseCapability`. Query-in / clean-results-out (`{ title, url, snippet, source? }[]`), with the query length-guarded under Brave's 400-char `q` cap. It reuses `executeHttpRequest` (`lib/orchestration/http`) — the same hardened outbound path as `call_external_api` (allowlist, outbound rate limit, auth-secret resolution, timeout, response cap). Brave is the only backend today, selected in `resolveSearchBackend()`; **Tavily/SerpAPI are drop-in branches** behind the same normalized return.

- Registered via the app seam `lib/app/capabilities.ts` (`registerAppCapability`) — **promotable to a Sunrise built-in** (`lib/orchestration/capabilities/built-in/`) with no interface change.
- Seeded (`aiCapability` + agent binding) by `071-web-search-capability.ts`; bound to the Report Research agent only.
- `processesPii = true` — queries are agent-generated from respondent answers, so `redactProvenance()` masks the query on the durable audit row.
- **Never throws** on an unconfigured backend: a missing key / non-allowlisted host surfaces as a structured `CapabilityResult` error, which the research loop treats as "no results".

Auth mirrors the provider-model-audit workflow exactly: `{ type: 'api-key', apiKeyHeaderName: 'X-Subscription-Token', secret: 'BRAVE_SEARCH_API_KEY' }` (Brave rejects `Authorization: Bearer` with HTTP 422).

## The research module (tool loop)

`lib/app/questionnaire/report/research.ts` → `runReportResearch({ phase, instructions, rounds, maxResults, context, sessionId })`.

- Resolves the seeded **Report Research agent** (`app-report-researcher`, `070-report-researcher-agent.ts`) at the **reasoning tier** (empty `model`/`provider` → `resolveAgentProviderAndModel(agent, 'reasoning')` → `gpt-5.4`). Query refinement + synthesis are reasoning-heavy.
- Runs a bounded **non-streaming tool loop** on `provider.chat(messages, { tools: [web_search], toolChoice: 'auto' })`: each round the agent issues one `web_search` (dispatched via `capabilityDispatcher.dispatch`), the results are fed back as a `role:'tool'` message, and the next query **builds on the accumulated results**.
- **Findings are the real, deduped search results** (grounded URLs — never model-invented). The agent additionally writes a short synthesis `note` guided by the admin's "what to do with the results" instruction.
- **Best-effort by contract — never throws.** A missing agent, unconfigured backend, or provider error returns whatever was gathered plus the accumulated cost. A report is never failed by research.
- **Time-boxed** per phase (`RESEARCH_PHASE_BUDGET_MS`) so a report's two phases + generation + formatter stay comfortably under the worker's 5-minute lease (`REPORT_LEASE_TTL_MS`), avoiding double-claim.

## Generation wiring

`lib/app/questionnaire/report/generate.ts`:

1. After client-KB grounding, if `research.enabled` **AND** the platform flag is on **AND** `timing ∈ {before, both}`: run the `before` round. When `informNarrative`, its findings/note are folded into the report prompt as an explicitly-**general** "External web research" block (honours the grounding rules — never attributed to the respondent).
2. After the report content (and the optional Report Formatter pass), if `timing ∈ {after, both}`: run the `after` round over the drafted report text.
3. `before` + `after` findings are merged (deduped by URL; the `after` note preferred), and attached to `content.research` **unless** `display === 'hidden'`. Research cost is summed into the report's `costUsd`.

The findings ride inside the existing `AppRespondentReport.content` JSON column (`RespondentReportResearch` in `report/content.ts`; `validateResearch` validates it and **requires a valid `http(s)` URL per finding**). `validateRespondentReportContent` preserves the block on read, so it survives the view/PDF path.

## Rendering

Both surfaces read `content.research` (no extra plumbing — it's part of `RespondentReportContent`):

- **On-screen:** `ReportBody` in `components/app/questionnaire/lifecycle/session-complete.tsx` renders a "Research & sources" table or list of linked titles + snippets per `display`.
- **PDF:** `InsightsSection` in `components/app/questionnaire/export/session-pdf-document.tsx` renders the same via `@react-pdf` `Link`.

## Operational notes

- **Latency vs the worker.** Report generation runs in the fire-and-forget maintenance-tick worker (`report/worker.ts`) and an opportunistic post-response `after()` kick on submit — neither blocks the respondent's submit. A research-enabled report may run minutes; the per-phase budget keeps it under the lease, and the cron is the lease-based backstop if a kick is cut off.
- **Cost.** Research cost sums into `AppRespondentReport.costUsd`; the research agent's `monthlyBudgetUsd` caps spend; Brave calls are subject to the existing per-host outbound rate limiter.

## Files

- Config/type: `lib/app/questionnaire/types.ts`, `report/settings.ts`, `authoring/config-schema.ts`
- Capability: `lib/app/questionnaire/capabilities/web-search.ts` (+ `constants.ts`, `lib/app/capabilities.ts`)
- Research module: `lib/app/questionnaire/report/research.ts`
- Generation: `lib/app/questionnaire/report/generate.ts`; content: `report/content.ts`
- UI: `components/admin/questionnaires/report/respondent-report-editor.tsx` (Research tab), `workspace-data.ts` (`reportWebSearch` flag)
- Rendering: `session-complete.tsx`, `session-pdf-document.tsx`
- Seeds: `prisma/seeds/app-questionnaire/069-report-web-search-flag.ts`, `070-report-researcher-agent.ts`, `071-web-search-capability.ts`
