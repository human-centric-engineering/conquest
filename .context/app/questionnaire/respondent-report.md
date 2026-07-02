# Respondent Report

The per-respondent report delivered after a respondent completes a questionnaire (report kind
`respondent`). The first of two report kinds — the later cross-respondent **Cohort Report**
(`cohort`) is a separate feature. Gated by the platform flag
`APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED` (a DB feature-flag row, seeded disabled by
`prisma/seeds/app-questionnaire/044-respondent-report-flag.ts`).

## Modes

- **`raw`** — answers only: the captured data-slot values and/or the questions as presented.
  Deterministic; rendered on demand (no stored report row). Each answer is rendered slot-aware by
  `formatSlotAnswer` — choice keys become their labels, booleans their custom labels, and a **likert
  point becomes its per-point label** (value `3` ⇒ "Neutral", not a bare "3"); an unlabelled/legacy
  scale falls back to the number. Labels are guaranteed at launch by the `scaleLabels` readiness check.
- **`raw_plus_insights`** — the raw report plus an AI-generated, actionable insights section,
  assembled by the report agent (optionally grounded in the client knowledge base). Generated once,
  asynchronously, after submit and stored in `AppRespondentReport`.
- **`narrative`** — a single woven report: the respondent's answers are integrated into flowing,
  analysed prose (analyses, insights, advice) rather than shown as a separate raw section. Same async
  lifecycle, agent, and stored content shape as `raw_plus_insights`; the difference is the prompt
  (woven framing) and the deliverable (the woven report **only** — no separate raw answer list).

`raw_plus_insights` and `narrative` are the **AI modes** — both stand up the report agent, generate
async, and persist an `AppRespondentReport` row. The shared predicate is `isAiRespondentReportMode`
in `lib/app/questionnaire/types.ts`; `raw` renders deterministically with no row.

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
- **Generation** (effective in the AI modes `raw_plus_insights` / `narrative`) — a **narrative-style**
  preset selector (`generation.narrativeStyle`: `flowing` | `concise` | `structured`, default `flowing`),
  the instructions, structure, and background-context textareas, the `useClientKnowledge` toggle, and
  the embedded `ClientKnowledgePanel`. The style preset shapes prose density/format and is orthogonal
  to the free-text `instructions` (tone/voice); all styles obey the same paragraph + grounding rules
  (below).
- **Delivery** — on-screen / download toggles (email deferred).
- **Appearance** — note that branding inherits the demo client's theme.

The page reads the resolved config from the cached version graph (no second fetch) and passes the
`respondentReport` slice in; the editor saves via `apiClient.patch` and `router.refresh()`.

The Generation panel does **not** manage documents — the knowledge base is owned by the **demo
client** (shared across all that client's questionnaires), so upload/list/delete lives on the client's
page (see below). When `useClientKnowledge` is on, the panel shows a note + a link to the attributed
client's page (or a "no client attributed" notice when the questionnaire is generic). The page passes
the attributed client to the editor via `getQuestionnaireDetailCached` (no extra fetch — the workspace
chrome already loads it).

### Config-crafting assistant (Phase 4b)

The Generation panel embeds `ReportConfigAssistant`
(`components/admin/questionnaires/report/report-config-assistant.tsx`) — a conversational helper that
interviews the admin and proposes report config. Each turn POSTs the transcript + the editor's live
generation values to `POST …/versions/:vid/report/craft` (`reportCraft` in `lib/api/endpoints.ts`),
which runs `craftReportConfig` (`lib/app/questionnaire/report/craft.ts`): it resolves the seeded
`app-respondent-report-assistant` agent (046) and runs the shared structured-completion runner,
returning `{ reply, suggestions }`. `suggestions` carries the **full** proposed text for any of
`instructions` / `structure` / `backgroundContext`; the admin applies a field wholesale via a
per-field "Apply" button (which calls back into the editor — config still saves through the normal
PATCH). The route is admin-only, gated on the master flag, and per-admin rate-limited
(`reportConfigAssistLimiter`). Stateless server-side — the transcript lives in the component. This
mirrors the generative-authoring **refine** pattern (a structured app turn), not the platform chat
tool-loop.

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
- The KB is **managed on the demo-client page** (`/admin/demo-clients/[id]`, a "Knowledge base"
  section rendering `ClientKnowledgePanel` from `components/admin/demo-clients/`), since the corpus
  belongs to the client, not a questionnaire. The panel reads the client-scoped list from
  `GET /api/v1/app/demo-clients/:id/knowledge` (`DEMO_CLIENTS.knowledge` in `lib/api/endpoints.ts`) →
  `getClientKnowledgeViewForClient(clientId)`. We deliberately do **not** call the platform's global
  documents list (it would show every client's docs). Uploads go through the platform upload endpoint
  with the client's tag pre-applied; only the scoped list lives app-side.

A demo client always has its own corpus (the tag is provisioned on demand). A questionnaire with no
attributed demo client simply can't ground its reports — its report editor shows a "no client
attributed" notice instead of a link.

## Storage (AI modes)

`AppRespondentReport` — one row per session (1:1, `onDelete: Cascade` so it follows the session and
GDPR erasure). Status `queued → processing → ready | failed`, the generated `content`, `costUsd`,
`notifyEmail` (respondent opt-in for a report-ready email; cleared once sent), and worker lease
columns (`lockedBy`/`lockedAt`) for the maintenance-tick generation worker (mirrors the evaluations
batch worker). Raw-only mode never creates a row.

## Generation pipeline (AI modes, async)

1. **Enqueue** — the submit route calls `enqueueRespondentReport(sessionId)`
   (`lib/app/questionnaire/report/enqueue.ts`) after `markSessionCompleted`. It creates a `queued`
   row only when the platform flag is on AND the version's config is `enabled` + an AI mode
   (`raw_plus_insights` or `narrative`, via `isAiRespondentReportMode`).
   Idempotent (upsert by `sessionId`); best-effort — a failure never fails submission.
2. **Worker** — `processQueuedRespondentReports()` (`lib/app/questionnaire/report/worker.ts`) runs in
   the maintenance-tick background chain (`lib/orchestration/maintenance/run-tick.ts`, task
   `respondentReports`). It lease-claims queued/orphan-stale rows (single conditional UPDATE; 5-min
   lease TTL), drains up to 5 per tick within a 45s budget, and marks each `ready` (+ content + cost)
   or `failed` (+ error), clearing the lease either way. On `ready`, if the row has a `notifyEmail` it
   sends the report-ready email best-effort (`sendRespondentReportReadyEmail` → `emails/respondent-report-ready.tsx`)
   and clears `notifyEmail`; a send failure is logged, never fails the report. A full-batch tick that
   leaves a large backlog logs `respondent report backlog` as an ops signal.

   **What drives the tick differs by environment — this is why prod stalled.** In dev an in-process
   ticker fires every 60s; in prod (Vercel serverless) there is no persistent process, so the tick is
   driven by the scheduled cron `GET /api/v1/cron/maintenance` (see
   [`../../orchestration/scheduling.md`](../../orchestration/scheduling.md)) which runs the chain in
   awaited mode. Additionally, the submit route kicks the worker via `after()` (`next/server`) right
   after enqueue, so a report starts generating within seconds rather than at the next cron minute;
   the lease makes the kick and the cron drain safe to overlap.

3. **Generation** — `generateRespondentReport(sessionId)` (`lib/app/questionnaire/report/generate.ts`)
   loads the answers (`loadSessionExport` → `buildAnswerPanelView` → `buildAnswerTranscript`),
   optionally retrieves client-KB snippets (scoped via `resolveClientKnowledgeDocumentIds` →
   `searchKnowledge({ documentIds })`), resolves the seeded `app-respondent-report` agent
   (`agent-resolver`), and runs the shared structured-completion runner (parse → retry-once → cost
   sum). Returns validated `RespondentReportContent` (`{ summary, sections[], actions[] }`) + USD cost.
   Blank generation config falls back to the agent's default persona — generic insights, no KB.

   **Prose quality rules baked into the prompt** (`buildReportMessages`): every observation must be
   grounded in a specific answer the respondent gave — no broad/sweeping generalisations the answers
   don't support, and no trait/conclusion attributed to them unless their answers established it
   (general context or illustrative examples are allowed, but must be framed as general and never
   asserted as facts about this respondent). The model is also told to write in short,
   blank-line-separated paragraphs (never one wall of text); the `narrativeStyle` preset layers
   density/format guidance on top (`flowing` / `concise` / `structured`). The renderers split
   `summary`/`body` on blank lines via `splitReportParagraphs`
   (`lib/app/questionnaire/report/content.ts`) so paragraphs lay out with real spacing in both the PDF
   (`SessionPdfDocument`) and the on-screen completion view. The seeded agent persona (045) carries the
   same grounding + short-paragraph guidance as its default voice.

The agent (`RESPONDENT_REPORT_AGENT_SLUG = 'app-respondent-report'`) is seeded disabled-of-impact by
`045-respondent-report-agent.ts` with an empty provider/model (resolved at runtime) and a monthly
budget cap; `visibility: 'internal'`.

## Respondent delivery

- **Status endpoint** — `GET /api/v1/app/questionnaire-sessions/:id/report` (`report` in
  `lib/api/endpoints.ts`) serves both respondent kinds via `resolveTurnAccess` (auth cookie or
  `X-Session-Token`). It returns the `RespondentReportClientView` built by
  `buildRespondentReportClientView` (`lib/app/questionnaire/report/view.ts`): `enabled` (config AND
  platform flag), `mode`, delivery toggles, and — for the AI modes (`raw_plus_insights`, `narrative`)
  — the insights `{ status, started, content, generatedAt, error, notifyRequested }`. `started`
  disambiguates a genuine `queued` row from "no row yet" (both surface `status: 'queued'`), so the UI
  can show "Starting…" vs "Preparing…"; `notifyRequested` reflects a stored `notifyEmail`.
- **Retry + notify endpoints** — `POST …/:id/report/retry` (`reportRetry`) re-queues a `failed` /
  orphaned-`processing` report (`requestRespondentReportRetry`, `lib/app/questionnaire/report/retry.ts`)
  and kicks the worker via `after()` — this is what makes "Check again" actually make progress rather
  than just re-reading a dead row. `POST …/:id/report/notify` (`reportNotify`, body `{ email }`) stores
  `notifyEmail` on an in-flight row for the report-ready email. Both are access-gated like the GET.
- **Completion screen** — `SessionComplete` calls `useRespondentReport`
  (`lib/hooks/use-respondent-report.ts`, 3s poll until terminal) and renders the generated content
  inline (starting/preparing → ready summary/sections/actions → failure fallback with a **Try again**)
  when `onScreen` + an AI mode. When generation outruns the poll window it shows the calm "taking
  longer" fallback with **Check again** (POSTs `reportRetry`, then re-polls) and an **email-me-when-ready**
  capture (POSTs `reportNotify` — anonymous respondents have no account email). The Download PDF button
  is gated on `delivery.download` (and defaults on when no report is configured, preserving the F7.4
  responses export). The completion screen never lists raw answers, so a narrative report already shows
  woven-only on screen.
- **PDF** — `SessionExportModel.insights` carries the ready content into the PDF and
  `SessionExportModel.narrativeOnly` selects the layout. The respondent `export.pdf` route loads the
  report via `buildRespondentReportClientView` (ready only):
  - **`raw_plus_insights`** → a "Your insights" section above the full answer record (raw + insights).
  - **`narrative`** → `narrativeOnly: true`: `SessionPdfDocument` renders the report alone under "Your
    personalised report" and **omits** the raw section/slot listing and the answered-count — the woven
    report is the whole deliverable.
    The **admin** session PDF (`questionnaires/:id/sessions/:sessionId/export.pdf`) embeds the same ready
    content but never sets `narrativeOnly`, so admins keep the full audit alongside the report. Anonymous
    respondents download via the session token; raw / not-yet-ready → answers only.
  - **Download title** — the export reads as the questionnaire, not a generic "Questionnaire":
    `SessionPdfDocument`'s `<Document title>` is the questionnaire's own title (browsers derive the
    suggested save/print filename from it); the completion screen names the blob download after the
    slugified title (`RespondentReportClientView.questionnaireTitle`, added to `view.ts`), since a blob
    URL loses the server's `Content-Disposition`; and both run pages
    (`(protected)/questionnaires/[sessionId]`, `(public)/q/[versionId]`) set their tab title via
    `generateMetadata` from the resolved header (the public one gated behind the live-sessions flag so a
    dark-launched surface can't leak a title).
