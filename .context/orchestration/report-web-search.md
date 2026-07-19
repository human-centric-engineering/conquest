# Report Web-Search Rounds

Optional web-search rounds that bring **live external context** into report generation. An admin configures, per questionnaire version, one or more search rounds that run **before** report generation (to inform the report), **after** it (to enrich / fact-check the finished report), or **both**. A seeded research agent runs the admin's instruction as iterative web searches — each round refining its query from the previous results — and the findings can surface in the report **three independent, combinable ways**: as a **cited sources section** (table or list of linked sources), woven into the **report narrative** where they strengthen a point, and/or as a **synthesized supporting appendix** (authored only when it genuinely improves the report — the writer's per-report choice).

Shipped for the **Respondent Report** (report kind `respondent`); the module is report-kind-agnostic, so the **Cohort Report** is an additive follow-up.

## Go-live checklist

To take this feature live in an environment (the feature is inert until all four are done):

1. **Seed** — `npm run db:seed` applies the Report Research agent (`070`) and the `web_search` capability + agent binding (`071`).
2. **Search backend** — set `BRAVE_SEARCH_API_KEY` and add `api.search.brave.com` to `ORCHESTRATION_ALLOWED_HOSTS` (both in `.env.local`). Until both are set, research is skipped and reports generate normally.
3. **Configure & verify** — on a questionnaire version's **Respondent Report → Research** tab, enable rounds and set instructions; complete a session; confirm the "Research & sources" block renders on the completion screen and in the exported PDF.

## Feature gate & configuration

- **Search backend (required to actually run):** `BRAVE_SEARCH_API_KEY` env var + `api.search.brave.com` in `ORCHESTRATION_ALLOWED_HOSTS`. Until both are set the feature is **inert** — research is skipped and the report generates normally. Same graceful-degradation contract as the provider-model-audit workflow.
- **Per-version config:** the `research` block inside the `respondentReport` JSON column (no migration — it nests in the existing column). Edited from the **Research tab** on the Respondent Report editor.

The `research` config (`RespondentReportSettings.research`, `lib/app/questionnaire/types.ts`):

| Field                                        | Meaning                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                    | Master toggle for this version's rounds.                                                                                                                                                                                                                                                      |
| `timing`                                     | `before` \| `after` \| `both`.                                                                                                                                                                                                                                                                |
| `rounds`                                     | Search calls per phase (1…`MAX_REPORT_RESEARCH_ROUNDS` = 5). Each round builds on the previous.                                                                                                                                                                                               |
| `maxResults`                                 | Results requested per round (1…`MAX_REPORT_RESEARCH_RESULTS` = 10).                                                                                                                                                                                                                           |
| `before.instructions` / `after.instructions` | The admin's prompt for each phase — purpose of the search + what to do with the results.                                                                                                                                                                                                      |
| `display`                                    | `table` \| `list` \| `hidden` — the **cited sources section**. `hidden` = no section (findings may still surface via the other two uses). UI label: "Show sources as" (List / Table / Don't show).                                                                                            |
| `informNarrative`                            | Whether `before` findings may inform the grounded report **narrative** (framed as general context, never attributed to the respondent). Applies to `before` findings only.                                                                                                                    |
| `appendix`                                   | Whether the writer may add a synthesized supporting **appendix** drawn from the findings — only when it genuinely improves the report (per-report agent's choice; most reports get none). Independent of `display`/`informNarrative`, and may draw on **both** `before` and `after` findings. |

The three uses are **independent and combinable** — e.g. a Table sources section **and** narrative weaving **and** an appendix, all at once. Defensive narrowing lives in `narrowRespondentReportSettings` (`report/settings.ts`); the strict Zod sub-schema is in `authoring/config-schema.ts`. `appendix` defaults to `false` (opt-in); a stored config missing it narrows to `false`.

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

A phase runs when **at least one of its surfaces is on**, so a config that surfaces nothing never pays for discarded calls. `before` surfaces via the narrative (`informNarrative`), the section (`display !== 'hidden'`), or the appendix (`appendix`); `after` surfaces via the section or the appendix.

1. After client-KB grounding, if `research.enabled` **AND** the platform flag is on **AND** `timing ∈ {before, both}` **AND** a `before` surface is on: run the `before` round. When `informNarrative`, its findings/note are folded into the report prompt as an explicitly-**general** "External web research" block (honours the grounding rules — never attributed to the respondent), which the writer may weave in where it strengthens a point.
2. After the report content (and the optional Report Formatter pass), if `timing ∈ {after, both}` **AND** an `after` surface is on: run the `after` round over the drafted report text.
3. `before` + `after` findings are merged (deduped by URL; the `after` note preferred), and attached to `content.research` **unless** `display === 'hidden'`.
4. **Appendix pass** (`report/appendix.ts` → `synthesiseReportAppendix`): when `appendix` is on **AND** any findings were gathered, the seeded **Report-Writer agent** is run once more over the finished report + the combined `before`/`after` findings and decides whether a short supporting appendix helps. It returns `{ appendix: null }` when none is warranted (the common case), so nothing is attached; otherwise the `content.appendix` block is attached. Best-effort — like research, it never throws.

All research + appendix cost is summed into the report's `costUsd`. The findings and the appendix ride inside the existing `AppRespondentReport.content` JSON column (`RespondentReportResearch` / `RespondentReportAppendix` in `report/content.ts`; `validateResearch` **requires a valid `http(s)` URL per finding**, `validateAppendix` requires a non-empty body). The report writer's own JSON is stripped of any `research`/`appendix` key it hallucinates, so those blocks can ONLY come from a real search round / the synthesis pass. `validateRespondentReportContent` preserves both blocks on read, so they survive the view/PDF path.

## Rendering

Both surfaces read `content.research` and `content.appendix` (no extra plumbing — both are part of `RespondentReportContent`):

- **On-screen:** `ReportBody` in `components/app/questionnaire/lifecycle/session-complete.tsx` renders the appendix (heading defaults to "Appendix") after the actions, then a "Research & sources" table or list of linked titles + snippets per `display`.
- **PDF:** `InsightsSection` in `components/app/questionnaire/export/session-pdf-document.tsx` renders the same via `@react-pdf` `Link`.

The **narrative** use has no separate render surface — it lands inside the report's own prose during generation.

## Operational notes

- **Latency vs the worker.** Report generation runs in the fire-and-forget maintenance-tick worker (`report/worker.ts`) and an opportunistic post-response `after()` kick on submit — neither blocks the respondent's submit. A research-enabled report may run minutes; the per-phase budget keeps it under the lease, and the cron is the lease-based backstop if a kick is cut off.
- **Cost.** Research cost sums into `AppRespondentReport.costUsd`; the research agent's `monthlyBudgetUsd` caps spend; Brave calls are subject to the existing per-host outbound rate limiter.

  > **Note (F14.15).** The `monthlyBudgetUsd` cap only became real in F14.15. Report-side calls previously invoked `getProvider` directly and never called `logCost`, so their spend reached neither `cost-reports.ts` nor per-agent budget enforcement — the cap documented here could not fire. They now route through `logAppLlmCost` (`lib/app/questionnaire/llm/log-app-cost.ts`). See [`ai-run-provenance.md`](../app/questionnaire/ai-run-provenance.md#cost-attribution).

## Files

- Config/type: `lib/app/questionnaire/types.ts`, `report/settings.ts`, `authoring/config-schema.ts`
- Capability: `lib/app/questionnaire/capabilities/web-search.ts` (+ `constants.ts`, `lib/app/capabilities.ts`)
- Research module: `lib/app/questionnaire/report/research.ts`; appendix synthesis: `report/appendix.ts`
- Generation: `lib/app/questionnaire/report/generate.ts`; content: `report/content.ts`
- UI: `components/admin/questionnaires/report/respondent-report-editor.tsx` (Research tab)
- Rendering: `session-complete.tsx`, `session-pdf-document.tsx`
- Seeds: `prisma/seeds/app-questionnaire/070-report-researcher-agent.ts`, `071-web-search-capability.ts`
