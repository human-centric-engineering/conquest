# Respondent Report

The per-respondent report delivered after a respondent completes a questionnaire (report kind
`respondent`). The first of two report kinds — the later cross-respondent **Cohort Report**
(`cohort`) is a separate feature. Gated by the platform flag
`APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED` (a DB feature-flag row, seeded disabled by
`prisma/seeds/app-questionnaire/044-respondent-report-flag.ts`).

## Modes

- **`raw`** — answers only: the captured data-slot values and/or the questions as presented.
  Deterministic; rendered on demand (no stored report row).
- **`raw_plus_insights`** — the raw report plus an AI-generated, actionable insights section,
  assembled by the report agent (optionally grounded in the client knowledge base). Generated once,
  asynchronously, after submit and stored in `AppRespondentReport`.

`narrative` (a fully woven report) is deferred (v2).

## Configuration

Per-version, stored as the `respondentReport` JSON slice on `AppQuestionnaireConfig` (mirrors the
`tone` precedent — see [configuration.md](./configuration.md)). Shape: `RespondentReportSettings` in
`lib/app/questionnaire/types.ts`; whole-block strict Zod in
`lib/app/questionnaire/authoring/config-schema.ts`; defensive read projection
`narrowRespondentReportSettings` in `lib/app/questionnaire/report/settings.ts`. Disabled by default.

## Admin configuration UI

The **Respondent report** workspace tab (`app/admin/questionnaires/[id]/v/[vid]/respondent-report`)
renders `RespondentReportEditor` (`components/admin/questionnaires/report/respondent-report-editor.tsx`)
— a self-contained controlled-state editor with four inner tabs that all edit one
`RespondentReportSettings` block, saved whole through the config PATCH (`respondentReport` slice):

- **Content** — enable toggle, mode selector, and the raw-content includes (questions-as-presented;
  data-slot values when the data-slots feature is on).
- **Generation** (effective in `raw_plus_insights`) — instructions, structure, and background-context
  textareas, the `useClientKnowledge` toggle, and the embedded `ClientKnowledgePanel`.
- **Delivery** — on-screen / download toggles (email deferred).
- **Appearance** — note that branding inherits the demo client's theme.

The page reads the resolved config from the cached version graph (no second fetch) and passes the
`respondentReport` slice in; the editor saves via `apiClient.patch` and `router.refresh()`.

`ClientKnowledgePanel` (`components/admin/questionnaires/report/client-knowledge-panel.tsx`) reads the
client-scoped `reportKnowledge` view, uploads to the platform documents endpoint with the client's
tag stamped on, lists the client's documents, and deletes them — degrading to a clear notice when the
questionnaire has no attributed client.

> **Deferred (Phase 4b):** the AI config-crafting chat + admin-interview assistant (a `ChatInterface`
> wired to a `craft-report-config` capability that proposes instructions/background context). The
> manual Generation fields are the source of truth; the assistant is an additive authoring aid.

## Per-client knowledge isolation (tag-based)

Modes 2/3 can ground insights in a client-specific knowledge base with strict no-bleed isolation —
**without forking the platform knowledge schema**. The mechanism reuses the existing platform
`KnowledgeTag` + document-tag join (the same machinery behind agent restricted-access):

- Each demo client gets a dedicated `KnowledgeTag`, provisioned lazily and idempotently by a
  deterministic slug (`app-client-<clientId>`). Its id is stored on
  `AppDemoClient.knowledgeTagId` (a plain scalar pointer — no `@relation`, so the app never edits the
  platform schema). See `ensureClientKnowledgeTag` in `lib/app/questionnaire/report/client-knowledge.ts`.
- A client's documents are those carrying its tag. `resolveClientKnowledgeDocumentIds(clientId)`
  returns that id list, used as the vector-search `SearchFilters.documentIds` allowlist
  (`lib/orchestration/knowledge/search.ts`) so retrieval is scoped to one client only.
- The Generation-tab KB viewer reads `GET /api/v1/app/questionnaires/:id/report/knowledge`
  (`reportKnowledge` in `lib/api/endpoints.ts`) — an app-side, client-scoped list. We deliberately do
  **not** call the platform's global documents list (it would show every client's docs). Uploads go
  through the platform upload endpoint with the client's tag pre-applied; only the scoped list lives
  app-side.

A questionnaire with no attributed demo client has no client corpus — the view returns
`client: null` and client knowledge is unavailable for its reports.

## Storage (mode 2)

`AppRespondentReport` — one row per session (1:1, `onDelete: Cascade` so it follows the session and
GDPR erasure). Status `queued → processing → ready | failed`, the generated `content`, `costUsd`, and
worker lease columns (`lockedBy`/`lockedAt`) for the maintenance-tick generation worker (mirrors the
evaluations batch worker). Raw-only mode never creates a row.

## Generation pipeline (mode 2, async)

1. **Enqueue** — the submit route calls `enqueueRespondentReport(sessionId)`
   (`lib/app/questionnaire/report/enqueue.ts`) after `markSessionCompleted`. It creates a `queued`
   row only when the platform flag is on AND the version's config is `enabled` + `raw_plus_insights`.
   Idempotent (upsert by `sessionId`); best-effort — a failure never fails submission.
2. **Worker** — `processQueuedRespondentReports()` (`lib/app/questionnaire/report/worker.ts`) runs in
   the maintenance-tick background chain (`lib/orchestration/maintenance/run-tick.ts`, task
   `respondentReports`). It lease-claims queued/orphan-stale rows (single conditional UPDATE; 5-min
   lease TTL), drains up to 5 per tick within a 45s budget, and marks each `ready` (+ content + cost)
   or `failed` (+ error), clearing the lease either way.
3. **Generation** — `generateRespondentReport(sessionId)` (`lib/app/questionnaire/report/generate.ts`)
   loads the answers (`loadSessionExport` → `buildAnswerPanelView` → `buildAnswerTranscript`),
   optionally retrieves client-KB snippets (scoped via `resolveClientKnowledgeDocumentIds` →
   `searchKnowledge({ documentIds })`), resolves the seeded `app-respondent-report` agent
   (`agent-resolver`), and runs the shared structured-completion runner (parse → retry-once → cost
   sum). Returns validated `RespondentReportContent` (`{ summary, sections[], actions[] }`) + USD cost.
   Blank generation config falls back to the agent's default persona — generic insights, no KB.

The agent (`RESPONDENT_REPORT_AGENT_SLUG = 'app-respondent-report'`) is seeded disabled-of-impact by
`045-respondent-report-agent.ts` with an empty provider/model (resolved at runtime) and a monthly
budget cap; `visibility: 'internal'`.
