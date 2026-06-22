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

## Data model

- `AppQuestionnaireConfig.cohortReport` — the JSON settings column (above).
- `AppCohortReport` — the generated report header, 1:1 with a round (`roundId @unique`), pinned to
  the delivered `versionId`. Carries generation `status` (queued|processing|ready|failed) + the
  worker lease (`lockedBy`/`lockedAt`, mirroring `AppRespondentReport`) and the `publishStatus`
  (draft|published) lifecycle. `onDelete: Cascade` from the round. The report **body** (ordered
  section blocks) lives in `AppCohortReportRevision` rows (F14.3) so every generate / edit / AI-assist
  is version-controlled.

## Roadmap

- **F14.1** ✅ — dataset & segmentation foundation, flag, config, base model.
- **F14.2** — `ChartSpec` + recharts web charts (shared series layer reused by the PDF).
- **F14.3** — `app-cohort-report` agent + thematic-analysis & narrative capabilities; revisions; SSE generation.
- **F14.4** — deterministic scoring engine (upload + visual builder), scored aggregation.
- **F14.5** — Settings tab, structure templates, Tiptap block editor, per-section AI-assist.
- **F14.6** — revision history/restore, publish, themed PDF (charts via react-pdf Svg), cross-report search.
