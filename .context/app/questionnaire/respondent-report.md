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
