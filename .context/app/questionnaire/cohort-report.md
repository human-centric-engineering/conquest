# Cohort Report (report kind `cohort`)

The **Cohort Report** is the cross-respondent analysis, charting and AI narrative an admin generates
over one **round's** submissions — segmented by the questionnaire's own demographics (team,
seniority, region, age group, …). It is the sibling of the per-respondent
[Respondent Report](./respondent-report.md): scope (one session vs many) is the distinguishing axis,
carried by the `ReportKind = 'respondent' | 'cohort'` enum (`lib/app/questionnaire/types.ts`).

It is being built as phase **P14**, feature-flagged and additive. This doc grows feature by feature;
F14.1 lands the foundation (the analytical substrate + flag + config + base model).

## Gating

Three flags, ANDed — a cohort report is round-scoped, so it sits on top of Cohorts & Rounds:

- `APP_QUESTIONNAIRES_ENABLED` (master)
- `APP_QUESTIONNAIRES_COHORTS_ENABLED` (cohorts/rounds exist)
- `APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED` (this feature; seeded **disabled** by `054-cohort-report-flag.ts`)

Resolved by `isCohortReportEnabled()` and the `ensureCohortReportEnabled()` / `withCohortReportEnabled()`
route gates in `lib/app/questionnaire/feature-flag.ts`. Per-version, a further `config.cohortReport.enabled`
toggle (the admin opt-in) ANDs on top once the editing surface ships (F14.5).

## Report scope — round **or** version-wide

A report's owner is **polymorphic** (`scope.ts` → `ReportScope = { kind: 'round' } | { kind: 'version' }`):

- **round** — one round's submissions (the original cohort report). Session filter `{ versionId, roundId }`.
- **version** — _all_ of a version's completed sessions, across **every round AND open-ended
  (non-round) sessions** — the version-wide cross-round synthesis. Session filter `{ versionId }`.

Both share the entire pipeline (dataset → digest → agent → revisions → publish → PDF → search); the
only differences — the session `where`, the display label, the round-only context lookups, and the
header upsert key — are encoded once in `scope.ts` (`scopeSessionWhere`, `scopeOwnerWhere`,
`scopeOwnerCreate`, `scopeRoundId`). The dataset/generator/persist/view layers take a `ReportScope`
and stay owner-agnostic; round routes pass `roundScope(...)`, version routes pass `versionScope(...)`.

`AppCohortReport` carries `scopeKind` plus two **nullable-unique** owner keys: `roundId` (round 1:1 +
FK/cascade, NULL for version rows) and `versionOwnerId` (= versionId, NULL for round rows). Postgres
multi-NULL unique indexes give one-report-per-round AND one-per-version without a partial index.
Migration: `20260626120000_app_cohort_report_polymorphic_owner` (no backfill — `scopeKind` defaults to
`round`, so existing rows classify themselves).

- **Round** routes: `app/api/v1/app/rounds/[id]/cohort-report/**` (gated by round bundling a version).
- **Version** routes: `app/api/v1/app/questionnaires/[id]/versions/[vid]/cohort-report/**` (gated by
  `loadVersionReportScope` + the same per-version `config.cohortReport.enabled` opt-in). Surfaced as the
  **Report** tab in the version workspace; the Analytics tab links to it.

## Streamed generation (SSE)

Generation streams its phases instead of blocking on one 90 s call. `streamGenerateCohortReport`
(`generate.ts`) is an async generator that `yield`s a `ReportGenProgressEvent` per phase
(`started → dataset_built{sessionCount,segmentCount} → material_built → context_loaded →
synthesizing`) and returns `{ content, costUsd }`; `generateCohortReport` is a thin drain-wrapper over
it (kept for non-streaming callers/tests). `streamReportRun` (`stream-run.ts`) wraps it for a route:
forwards each phase, then on the terminal step appends the AI revision + emits `done` (or marks the
header `failed` + emits `error`). The `…/cohort-report/generate/stream` routes (round + version) return
`sseResponse(streamReportRun(...))`; the admin panel consumes it and renders a live phase line. The
synchronous `…/generate` routes remain for back-compat.

## Config — `CohortReportSettings`

Stored as the lazy JSON column `AppQuestionnaireConfig.cohortReport` (mirrors `respondentReport`),
projected by `narrowCohortReportSettings` (`lib/app/questionnaire/cohort-report/settings.ts`) and
round-tripped through the version config read/write/fork paths
(`app/api/v1/app/questionnaires/_lib/detail.ts`, the `config` PATCH route, `copy-version-graph.ts`).
Defaults in `DEFAULT_COHORT_REPORT_SETTINGS` (`types.ts`): feature off, `business` formality,
`standard` length + detail, round/cohort context on, client-knowledge + scoring off. The full
generation block (length, detailLevel, formality, instructions, structure template, background
context, `useClientKnowledge` / `useRoundContext` / `useCohortContext`, `scoringEnabled`) is consumed
by the analysis + narrative agents (F14.3) and edited from the Settings tab (F14.5).

## The dataset — `buildCohortDataset` (F14.1)

`lib/app/questionnaire/cohort-report/dataset.ts` produces the serializable `CohortDataset` for one
round + version — the substrate that charts (F14.2), the agents (F14.3), and the admin UI all
consume. It **reuses the F8.1/F8.3 analytics machinery wholesale**: the per-question distribution
assembly was extracted from `analytics/distributions.ts` into the pure
`assembleQuestionDistributions(slots, sessions, answers)`, which `buildCohortDataset` calls once for
the whole round and again per demographic segment over the matching session subset. Three queries
(slots, sessions + profile snapshot, answers); everything else is in-memory grouping.

**Segmentation axes** come from the questionnaire itself:

- **Profile fields** — any `profileFields` entry of type `select` (bucketed by option) or `number`
  (bucketed into up to 6 equal-width ranges, e.g. age groups). Values read from
  `AppRespondentProfileSnapshot.values`.
- **Cohort subgroup** — splits by the session's `cohortSubgroupId` snapshot (names resolved from
  `AppCohortSubgroup`). The `SegmentDimension.key` for this axis is the sentinel
  `SUBGROUP_DIMENSION_KEY`.

**Privacy.** k-anonymity is applied at the data boundary, per segment, by the same
`isCohortSuppressed` (threshold `K_ANONYMITY_THRESHOLD = 5`) the analytics aggregators use — so a
demographic segment below the floor has its per-question detail withheld (`detail.kind: 'suppressed'`)
exactly like the version-wide analytics. **Anonymous mode** (`config.anonymousMode`) yields no
demographic segmentation at all — the report is cohort-level only.

### Endpoint

`GET /api/v1/app/rounds/:id/cohort-report/dataset?versionId=…` — `withAdminAuth`, gated by
`withCohortReportEnabled`. Validates the version is one the round bundles
(`assertRoundBundlesVersion`) and returns the `CohortDataset`.

## Charts — `ChartSpec` → `ChartData` (F14.2)

Charts are **declarative**. A `ChartSpec` (`lib/app/questionnaire/cohort-report/chart-types.ts`)
says _what_ to plot — a `kind` (`question_distribution`, `question_mean_by_segment`,
`response_rate_by_segment`, `completion_by_segment`, `segment_sizes`), an optional `questionId` /
`dimensionKey`, and a `display` hint. `buildChartData(spec, dataset)`
(`chart-series.ts`, pure) resolves it against the `CohortDataset` into a uniform `ChartData`
(categories × series). **One `ChartData` drives both renderers**: the recharts web component
`CohortChart` (`components/admin/questionnaires/cohort-report/charts/cohort-chart.tsx`) and — later —
the react-pdf chart (F14.6), so a chart looks identical on screen and in the download.

`buildChartData` never throws on a bad spec: an unknown question/dimension or a free-text question
returns `empty: true`; a k-anonymity-suppressed question/segment returns `suppressed: true` (or is
omitted from a by-segment series) rather than a misleading zero. The analysis agent proposes a
`ChartSpec[]` it judges significant (F14.3); the admin pins/adds/removes (F14.5).

## Data slots — the semantic substance (F14.7)

Data slots (`AppDataSlotFill`) carry the meat of the responses — the agent's natural-language
restatement of each respondent's position per topic — so they are first-class in the cohort analysis:

- **Aggregate** (`CohortDataset.dataSlots`, built in `dataset.ts`) — per slot: fill rate, mean
  confidence, provenance breakdown overall, and fill rate per segment. Counts only (k-anonymity-safe),
  reusing the same dimension groupings as question segmentation. Charted via the
  `dataslot_response_overall` / `dataslot_response_by_segment` chart kinds; summarised in the digest.
- **Raw thematic material** (`data-slot-material.ts`, **server-side only**) — for the narrative agent,
  the per-slot respondent paraphrases are loaded into the prompt as the primary thematic-analysis
  material, with an explicit instruction to **synthesise anonymised themes, never quote or attribute
  an individual**. These raw positions never reach the client `CohortDataset`. k-anonymity: a slot
  answered by fewer than the threshold contributes no samples, and the whole block is skipped for a
  below-floor cohort.

## Generation & revisions (F14.3)

The report is produced by the seeded **`app-cohort-report`** agent (seed `055`) via a direct
structured completion — the same direct-agent pattern as the Respondent Report (`report/generate.ts`),
not a dispatcher capability. `generateCohortReport` (`cohort-report/generate.ts`) feeds the agent the
k-anonymity-safe dataset digest + chart catalog (`content.ts`'s `buildCohortDatasetDigest` /
`buildChartCatalogText`), the admin's generation config (length / detail / formality / instructions /
structure template / background), and — when the toggles are on — the round briefing, cohort
background, and client-KB snippets. It does the thematic analysis, weaves the narrative, **proposes
the charts** (a `ChartSpec[]` referencing only the catalogued ids), and ends with recommendations +
actions, all in one validated structured output (`validateCohortReportContent` drops malformed charts
and dangling references — a bad generation can never persist a broken revision).

**Revisions.** Every generation / edit / AI-assist appends an `AppCohortReportRevision`
(`persist.ts`, never mutates) so the authoring history is preserved; the working head is the highest
`revisionNumber`. `buildCohortReportView` (`view.ts`) assembles the client-safe read shape: header
status + the head revision's content + the dataset the charts render against.

### Endpoints

- `GET …/cohort-report?versionId=` — the read view (`exists:false` before first generation).
- `POST …/cohort-report/generate` `{ versionId }` — generate + append an AI revision; gated by the
  flag AND the per-version `config.cohortReport.enabled` toggle; per-admin generate sub-cap (paid).
- `GET …/cohort-report/dataset?versionId=` — the raw dataset (F14.1).

The admin surface is the **Cohort report** section on the round detail page
(`components/admin/cohorts/cohort-report-panel.tsx`): pick a bundled version, Generate / Regenerate,
and read the narrative + charts + recommendations + actions. The full block editor + per-section
AI-assist land in F14.5.

## Settings, templates & editing (F14.5)

**Settings** (per version, `config.cohortReport`) — enable, length / detail / formality, a free-text
**structure template** (the AI fills it; blank = auto), style/background, and the context + scoring
toggles — are edited by `CohortReportSettingsForm` on the **Scoring** workspace tab (saved via the
version-config PATCH, fork-on-launch like all config).

**Editing.** A generated report is editable on the round panel (`CohortReportEditor`): a **Tiptap**
WYSIWYG per section (bold/italic/lists/headings), reorder (up/down), add / delete / duplicate, and a
**per-section AI-assist** ("make it shorter", "add the evidence") via `POST …/cohort-report/refine`
(`refine.ts`, reuses the cohort-report agent). Saving `PATCH …/cohort-report` appends an `admin`
revision — every edit is version-controlled.

**Storage.** Section bodies are stored as **HTML** so the editor, read view and PDF speak one format.
The AI writes markdown, converted once at the generation boundary (`markdownToHtml`, `richtext.ts`);
the `CohortReportSection.format` field marks `html` vs legacy `markdown`. HTML is **sanitised at the
render boundary** (`CohortSectionBody` → dompurify with an explicit tag allowlist), the standard XSS
defence for stored rich text.

**Formatter seam (not yet wired).** The Report Formatter second pass built for the Respondent Report
(`formatReportContent`, `lib/app/questionnaire/report/format.ts` — re-paragraphing, bullet conversion,
AI-ism removal) is report-kind-agnostic: it operates on the shared `summary / sections[{heading,body}]
/ actions` core and takes a `format: 'markdown'` option precisely so the cohort report can adopt it
**before** the `markdownToHtml` conversion (charts/`chartIds`/`recommendations` pass through untouched).
It is deliberately **not** auto-wired here: cohort bodies are admin-authored/edited in Tiptap, streamed,
and version-controlled, so auto-rewriting hand-authored prose is intrusive. The recommended adoption is
an **opt-in "Polish formatting" action** in the editor (sibling to the per-section AI-assist), not a
forced step in the streaming/publish path. See [`respondent-report.md`](./respondent-report.md).

## Deterministic scoring (F14.4)

The "hard rules" path — scoring a questionnaire like a psychometric instrument (e.g. Big Five). A
versioned **`AppScoringSchema`** (1:1 with a version, forks on launch like config) defines named
**scales**, the **items** that feed each (a question/data-slot key → scale, with `weight` +
`reverse`), the combine **method** (`sum`/`mean`), and **band** cutoffs. The pure engine
`scoreSession` (`scoring/score.ts`) turns one respondent's numeric answers into per-scale raw scores

- normalised position + band; `scoring/compute.ts` is the I/O layer (loads answers, scores, and
  optionally persists **`AppRespondentScore`** rows).

**Both authoring paths, one schema:**

- **Visual builder** — `ScoringBuilder` (`components/admin/questionnaires/cohort-report/`) on the
  **Scoring** workspace tab (gated by `flags.cohortReport`); saves via
  `PATCH …/versions/:vid/scoring-schema` (forks-if-launched, recomputes scores).
- **Upload** — `POST …/scoring-schema/extract` parses a scoring document and runs the cohort-report
  agent (`scoring/extract.ts`) to PROPOSE a schema scoped to the version's real keys; the admin
  reviews it in the builder and saves through the same PATCH.

**Scored aggregation.** When `config.cohortReport.generation.scoringEnabled` is on and a schema
exists, `buildCohortDataset` adds a `scoring` block: per-scale overall summaries (mean + band
distribution) and per-dimension per-scale segment means — built from the same dimension groupings as
the question segmentation, under the same k-anonymity floor. The narrative digest surfaces the scores
so the report can reason over them as hard inputs.

## Versioning, publish, PDF & search (F14.6)

- **Revision history + restore** — `GET …/cohort-report/revisions` lists every revision (newest
  first); `POST` restores one by appending it as a new `admin` revision (history is never rewritten).
- **Publish** — `POST …/cohort-report/publish` pins a revision (`publishedRevisionNumber`, default
  the head); `DELETE` reverts to draft. The panel shows which revision is live.
- **Themed PDF** — `GET …/cohort-report/export.pdf?versionId=&revision=head|published|<n>` renders any
  revision to a branded PDF (`CohortReportPdfDocument`, demo-client logo + accent via `resolveTheme`).
  Section HTML is flattened to text paragraphs (`pdf-model.ts`'s `htmlToParagraphs`) and charts are
  drawn as labelled bars from the shared `ChartData` — so a draft is downloadable at any point.
- **Search** — `GET /api/v1/app/cohort-reports/search?q=&demoClientId=` searches PUBLISHED reports'
  titles + section text and returns snippets. Within-report find is the browser's native search over
  the rendered report.

## Data model

- `AppQuestionnaireConfig.cohortReport` — the JSON settings column (above).
- `AppCohortReport` — the generated report header, 1:1 with a round (`roundId @unique`), pinned to
  the delivered `versionId`. Carries generation `status` (queued|processing|ready|failed) + the
  worker lease (`lockedBy`/`lockedAt`, mirroring `AppRespondentReport`) and the `publishStatus`
  (draft|published) lifecycle. `onDelete: Cascade` from the round. The report **body** (ordered
  section blocks) lives in `AppCohortReportRevision` rows (F14.3) so every generate / edit / AI-assist
  is version-controlled.

## Roadmap (all shipped)

- **F14.1** ✅ — dataset & segmentation foundation, flag, config, base model.
- **F14.2** ✅ — `ChartSpec` + recharts web charts (shared `ChartData` reused by the PDF).
- **F14.3** ✅ — `app-cohort-report` agent + generation; revisions; charted narrative + actions.
- **F14.4** ✅ — deterministic scoring engine (upload + visual builder), scored aggregation.
- **F14.5** ✅ — settings + structure template, Tiptap block editor, per-section AI-assist.
- **F14.6** ✅ — revision history/restore, publish, themed PDF (charts as bars), cross-report search.
