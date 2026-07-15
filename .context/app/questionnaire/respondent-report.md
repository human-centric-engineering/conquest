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
  analysed prose (analyses, insights, advice). Same async lifecycle, agent, and stored content shape
  as `raw_plus_insights`; the difference is the prompt (woven framing). By default the woven report is
  the whole deliverable, but the **include-questionnaire-data** toggles (below) can append the
  respondent's own data beneath it.

`raw_plus_insights` and `narrative` are the **AI modes** — both stand up the report agent, generate
async, and persist an `AppRespondentReport` row. The shared predicate is `isAiRespondentReportMode`
in `lib/app/questionnaire/types.ts`; `raw` renders deterministically with no row.

### Including the questionnaire data (all modes)

The `rawIncludes` config chooses which of the respondent's own questionnaire data accompanies the
report, in **every** mode:

- `rawIncludes.questionsAsPresented` — the question-by-question answer record (each answer rendered
  slot-aware by `formatSlotAnswer`).
- `rawIncludes.dataSlots` — the captured **data-slot** values (the respondent-facing paraphrase per
  slot, grouped by theme). Only meaningful for a version running in a data-slot mode; the toggle is
  hidden unless the data-slots feature is on.

In `raw` mode this data **is** the report. In `raw_plus_insights` it is **appended beneath** the
generated report per the toggles. A **`narrative`** report is a standalone woven deliverable, so it
**never appends the Q&A recap** — the respondent-facing `questions` include is always suppressed for
narrative, regardless of the stored `questionsAsPresented` flag (`resolveReportRawIncludes` in
`report/settings.ts`, the single source of truth used by both the render in `report/view.ts` and the
writer-prompt hint in `report/generate.ts`). This restores the pre-F10.6 `narrativeOnly` invariant
**without a data backfill**: versions configured as `narrative` before F10.6 carry the field's default
`questionsAsPresented: true`, which would otherwise start surfacing a full Q&A recap on existing
reports. The optional **captured-information (data-slot) appendix stays config-driven in every mode**
(new in F10.6, defaults off, so no existing version can regress into showing it) — a narrative report
may still opt into it. The editor hides the Q&A toggle in narrative mode accordingly; switching away
restores `questionsAsPresented` (`changeMode` in `respondent-report-editor.tsx`). The same config
drives both the on-screen completion card (and its A4 preview) and the downloadable PDF, so the two
artifacts match. When data is appended, the report agent is told the respondent can already see it in
full alongside the report, so it should analyse/synthesise rather than restate it (see
`APPENDED_DATA_RULES` in `report/generate.ts`).

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

- **Content** — enable toggle, mode selector, and the **include-questionnaire-data** toggles
  (questions-as-presented; captured data-slot values when the data-slots feature is on). The toggles
  are shown for **all** modes, including `narrative` — turning one on appends that data beneath the
  woven report (both off ⇒ woven-only prose).
- **Generation** (effective in the AI modes `raw_plus_insights` / `narrative`) — a **narrative-style**
  preset selector (`generation.narrativeStyle`: `flowing` | `concise` | `structured`, default `flowing`),
  the instructions, structure, and background-context textareas, the `useClientKnowledge` toggle, and
  the embedded `ClientKnowledgePanel`. The style preset shapes prose density/format and is orthogonal
  to the free-text `instructions` (tone/voice); all styles obey the same paragraph + grounding rules
  (below). Also here: the **data-slot influence** slider and the **discount low-confidence** toggle
  (both under `generation` — see [Data-slot influence & confidence](#data-slot-influence--confidence)),
  and a **Preview report** button (see [Config preview](#config-preview-ai-synthesised)).
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
GDPR erasure). Status `queued → processing → ready | failed`, the generated `content`, `formatted` (whether the
Report Formatter second pass laid out the stored prose — see below), `completionPct` (questionnaire
completion % at generation — drives the partial-report caveat), `costUsd`,
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

   The transcript leads with the questionnaire context for grounding: title, goal, and the **full
   structured audience** — every field the admin set (`description`, `role`, `expertiseLevel`,
   `estimatedDurationMinutes`, `locale`, `sensitivity`, `notes`), each rendered as its own labelled
   line by `describeAudience` (`report/content.ts`), not a one-line summary.

   The DB load (steps + transcript + data-slot block + completion %) is split from the generation core:
   `generateRespondentReport(sessionId)` builds the inputs, then delegates to the exported
   `generateReportFromInputs(inputs)` (KB → agent → research rounds → completion → formatter → appendix).
   The [config preview](#config-preview-ai-synthesised) reuses that core with synthesised sample answers,
   so a previewed and a live report share one generation path.

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

4. **Formatting (optional second pass, flag-gated)** — when `APP_REPORT_FORMATTER_ENABLED` is on,
   generation runs a second agent (`REPORT_FORMATTER_AGENT_SLUG = 'app-report-formatter'`, seeded by
   `061-report-formatter-agent.ts`) over the writer's output via `formatReportContent`
   (`lib/app/questionnaire/report/format.ts`). It does **form only**: re-paragraphs at natural
   boundaries, converts inline dash-runs into bullet lists, and strips AI-isms (em-dash overuse,
   flowery filler) — the things the content agent self-polices poorly and the deterministic
   `splitReportParagraphs` split can only approximate with a blunt sentence count. When the flag is on,
   agent 1's prompt is **thinned** — it sheds the strict paragraph/bullet mechanics (layout is now the
   formatter's job) so it focuses on grounded substance. **Fidelity is load-bearing**: a guard verifies
   the formatter preserved structure (same sections, headings, and action count); on any drift, parse
   failure, timeout, or provider error it returns the **original content unchanged** and the pass never
   fails an otherwise-valid report. `actions` pass through verbatim. Success stores `formatted = true`
   and sums the second call's cost; both renderers then honour the formatter's paragraphs/bullets
   **verbatim** (`splitReportParagraphs(text, { trustParagraphs: true })` — skips the sentence
   re-grouping). `formatted = false` (flag off, fallback, or legacy rows) keeps the deterministic split.
   Report-kind-agnostic (operates on the shared `summary / sections[{heading,body}] / actions` core), so
   the Cohort Report can adopt it later (passing `format: 'markdown'`) — see the seam note in
   [`cohort-report.md`](./cohort-report.md).

The agent (`RESPONDENT_REPORT_AGENT_SLUG = 'app-respondent-report'`) is seeded disabled-of-impact by
`045-respondent-report-agent.ts` with an empty provider/model (resolved at runtime) and a monthly
budget cap; `visibility: 'internal'`. The formatter agent (`app-report-formatter`,
`061-report-formatter-agent.ts`) is seeded the same way but resolves at the cheaper `chat` tier —
formatting is largely mechanical.

## Data-slot influence & confidence

Two `generation` knobs shape how the AI report weighs the respondent's captured data (both AI modes):

- **`generation.dataSlotInfluence`** (0–100, default 50) — a soft weighting between the **direct
  questionnaire answers** and the conversational **data-slot** understanding. When the version has data
  slots, `buildDataSlotContextBlock` (`report/content.ts`) flattens each filled slot (its captured
  paraphrase + the agent's rationale) into a themed context block that `buildReportMessages` folds into
  the system prompt, followed by an instruction to balance the report roughly `100 - dataSlotInfluence`%
  on the answers and `dataSlotInfluence`% on the data-slot context. It is **emphasis guidance, not a
  hard rule** — prose influence can't be enforced deterministically — and is inert when the version has
  no data slots (the block is empty, the instruction is omitted, and the report behaves as before).
  Independent of the [`rawIncludes`](#including-the-questionnaire-data-all-modes) display toggles:
  influence feeds the prompt whether or not the data is _shown_ beneath the report.
- **`generation.discountLowConfidence`** (default on) — surfaces each answer's and data-slot fill's
  confidence (`0–1`, from the extractor) into the prompt (`(confidence 0.42)` suffixes, via
  `buildAnswerTranscript` / `buildDataSlotContextBlock` `{ includeConfidence }`), plus an instruction to
  give low-confidence items less weight and disregard the unreliable. Off ⇒ every captured answer is
  treated equally and no confidence is shown.

To feed the data-slot rationale + confidence, `loadSessionExport` loads them onto each
`ExportDataSlotGroup` slot (`rationale` / `confidence`, additive — the respondent-facing "Captured
information" appendix ignores them).

## Config preview (AI-synthesised)

The Generation tab's **Preview report** button lets an admin see how the configured report will read
**before going live**, without a real respondent. It posts the current (possibly unsaved) config to
`POST …/versions/:vid/report/preview` (`reportPreview` in `lib/api/endpoints.ts`; admin-only, master-flag
gated, per-admin `reportPreviewLimiter` — two LLM calls per preview). The route:

1. loads the version's structure (questions + data slots);
2. `synthesiseSampleReportInputs` (`lib/app/questionnaire/report/preview-sample.ts`) invents a single
   plausible sample respondent via one structured LLM call and maps it through the **same**
   `buildAnswerTranscript` + `buildDataSlotContextBlock` builders production uses;
3. forces `research.enabled = false` and `generation.useClientKnowledge = false` (previews are fast,
   cheap, deterministic — no web search, no KB dependency), then runs `generateReportFromInputs`.

Only the **AI modes** are previewable (a `raw` config is rejected — its output is just the answers,
previewed via the respondent walkthrough). The editor renders the returned `RespondentReportContent`
in a paper dialog using the shared `ReportBody` / `ReportPaperHeader`
(`components/app/questionnaire/report/report-body.tsx`, extracted from `session-complete.tsx` so preview
and the live respondent view can't drift), behind a caveat banner ("sample answers; research/KB skipped").
Nothing is persisted.

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
  is gated on `delivery.download` **and**, in an AI report mode, on the report being `ready` — the
  downloaded PDF's headline _is_ the report, so the button is held until generation finishes (raw /
  disabled modes still download the answers PDF immediately, preserving the F7.4 responses export). The
  conversation record downloads separately via the **Chat Transcript** menu (`TranscriptDownload`),
  available regardless of report config. When the config includes questionnaire data (`includeData` on
  the report view, from `rawIncludes`), `ReportDataAppendix` renders a **"Captured information"** and/or
  **"Your responses"** section beneath the report — on the card and the A4 preview — sourced from the
  panel the respondent saw (`captured`). In data-slot mode `captured.sections` is empty, so the Q&A
  recap only appears for question-mode versions (matching what the respondent actually saw).
- **Partial-report caveat** — a session can be submitted early (before 100% of slots are answered). At
  generation the pipeline records `completionPct` (answered / total slots, frozen); below
  `PARTIAL_REPORT_THRESHOLD_PCT` (75) both renderers show a caveat subtitle naming the exact %
  ("…based on a partially complete questionnaire (N% complete)…"). It is **deterministic** — computed by
  `partialReportCaveat` (`report/content.ts`), never generated by an agent: the exact figure and wording
  must not drift, and the Report Formatter's fidelity guard would in any case reject an injected caveat.
  Legacy rows (`completionPct` null) carry no caveat.
- **PDF** — `SessionExportModel.insights` carries the ready content into the PDF; `narrative`,
  `includeQuestions`, and `includeDataSlots` select the layout; `insightsFormatted` +
  `insightsCompletionPct` carry the formatter-trust flag and completion % so the PDF matches the
  on-screen render (same trusted paragraphs, same caveat). The captured data-slot values ride along as
  `SessionExportModel.dataSlots` (loaded by `loadSessionExport` from `AppDataSlot` + `AppDataSlotFill`,
  grouped by theme). Both `export.pdf` routes pass these via a single `SessionReportEmbed` options object
  to `buildSessionExportPdfModel(loaded, { insights, narrative, includeQuestions, includeDataSlots, formatted, completionPct })`
  — grouped (not trailing positional args) so the flags can't be transposed. The respondent route loads
  the report via `buildRespondentReportClientView` (ready only) and honours `rawIncludes`:
  - **`raw_plus_insights`** → a "Your insights" section, then (per config) a "Captured information"
    appendix and/or the full "Your responses" answer record.
  - **`narrative`** → the woven report under "Your personalised report" (`narrative: true` drives the
    title), followed by the same optional appendix. With both include flags off it is the woven report
    alone; `SessionPdfDocument` omits the answer listing and the answered-count when `includeQuestions`
    is false. Fallback: if the AI report isn't embedded yet (still generating), the respondent route
    forces `includeQuestions` on so the download is never an empty document.

  The **admin** session PDF (`questionnaires/:id/sessions/:sessionId/export.pdf`) always sets
  `includeQuestions: true` (admins keep the full answer audit alongside the report) and follows the
  config for the data-slot appendix. Anonymous respondents download via the session token; raw /
  not-yet-ready → answers only.
  - **Download title** — the export reads as the questionnaire, not a generic "Questionnaire":
    `SessionPdfDocument`'s `<Document title>` is the questionnaire's own title (browsers derive the
    suggested save/print filename from it); the completion screen names the blob download after the
    slugified title (`RespondentReportClientView.questionnaireTitle`, added to `view.ts`), since a blob
    URL loses the server's `Content-Disposition`; and both run pages
    (`(protected)/questionnaires/[sessionId]`, `(public)/q/[versionId]`) set their tab title via
    `generateMetadata` from the resolved header (the public one gated behind the live-sessions flag so a
    dark-launched surface can't leak a title).
