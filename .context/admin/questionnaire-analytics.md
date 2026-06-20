# Questionnaire analytics (F8.1)

Version-scoped admin page at `/admin/questionnaires/[id]/analytics?v=[versionId]` — the read-side
view of a version's completed-session data. Three surfaces in tabs: per-question **distributions**,
the completion **funnel**, and **cost** actuals. Reached from the `Analytics` button on the
questionnaire detail page. Read-only, admin-only, master-flag-gated (`APP_QUESTIONNAIRES_ENABLED`).

> **Source of truth:** aggregators in `lib/app/questionnaire/analytics/`, routes under
> `app/api/v1/app/questionnaires/[id]/versions/[vid]/analytics/`, UI in
> `app/admin/questionnaires/[id]/analytics/` + `components/admin/questionnaires/analytics/`.
> Update this doc when those change.

## Scope & filter

One shared filter (`analytics-filters.tsx`) drives all three views through the URL:

- **Date window** — `from`/`to` (`YYYY-MM-DD`), default last 30 days (reuses the platform
  `resolveAnalyticsDateRange` so questionnaire and orchestration share one "30 days").
- **Tag filter** — `tagIds` (comma-separated). Restricts the **distributions** view to questions
  carrying any selected tag; the funnel and cost views ignore it.
- **Version** — `?v=` (the page owns this, SSR links), like the evaluations/invitations sub-pages.
- **Round scope** — `roundId` (Cohorts & Rounds). Absent = **all sessions** (the version-wide,
  mixed view). A round id = **only that round's** sessions, so one cohort's run of the questionnaire
  is analysed in isolation — different cohorts/rounds of the same questionnaire are never blended.
  The literal `none` = only non-round (open-ended) sessions. The selector lists just the rounds that
  actually produced sessions for this version (`listRoundsForVersion`), and only appears when the
  `APP_QUESTIONNAIRES_COHORTS` flag is on. The translation point is `roundSessionFilter(roundId)` in
  `query-schema.ts`, spread into every aggregator's session `where` (and the funnel's round-bound
  invitation query) so all surfaces scope identically. See [cohorts.md](../app/questionnaire/cohorts.md).

All aggregations count **non-preview** sessions only (`isPreview = false`).

## The three surfaces

**Distributions** (`distributions.ts`) — per question, a type-appropriate breakdown over the
answers captured in scope:

| Type                | Detail                                                         |
| ------------------- | -------------------------------------------------------------- |
| single/multi choice | count per option + an "other/unlisted" bucket                  |
| likert              | count per scale point + mean                                   |
| numeric             | min/max/mean/median + histogram                                |
| boolean             | true/false counts (custom labels)                              |
| date                | counts bucketed by month                                       |
| **free_text**       | **no values** — response rate, avg confidence, provenance only |

Every question also reports answered/unanswered counts, response rate (denominator = sessions in
scope), avg confidence, and the provenance mix (`direct`/`inferred`/`synthesised`/`refined`).
**Free-text answer values are never serialised** — F8.1 stays PII-safe ahead of F8.3.

**Funnel** (`funnel.ts`) — invited → opened → started → completed, with per-stage drop-off,
retention (vs invited), and step conversion. Invited/opened come from invitation timestamps
(`sentAt`/`openedAt`, excluding revoked); started/completed are derived from real sessions matched
to invited respondents by `userId`. **Anonymous (un-invited) sessions** are reported separately
(they enter at "started") so the invite funnel isn't overstated.

**Cost** (`cost.ts`) — total spend split into **respondent runtime** vs **design-time**, a
per-capability breakdown, a daily trend, and the top sessions by spend. Reads the platform
`AiCostLog` ledger via raw SQL over its `metadata` JSON.

## Cost attribution contract

Questionnaire LLM spend is attributed in `AiCostLog.metadata`:

- **Runtime** (live respondent turns) → `metadata.appQuestionnaireSessionId` = the session cuid.
  Stamped by the session-bound capabilities (`extract_answer_slots`, `detect_contradictions`,
  `refine_answer`, `compose_completion_offer`) and the adaptive selector. F8.1 standardised these
  on the `appQuestionnaireSessionId` key (previously a bare `sessionId` in the four capabilities).
- **Design-time** (structure evaluation) → `metadata.versionId`, stamped by `evaluate_structure`.

A version's spend = the ledger rows for its non-preview sessions (runtime) ∪ the rows tagged with
its version id (design-time). The two key sets are disjoint, so there's no double-counting.
`AppQuestionnaireTurn.costUsd` is unrelated to this view — it's the F6.3 budget-enforcement basis
and is left untouched. One-time ingest cost (`extract_questionnaire_structure`, logged before a
version exists) is not version-attributable and is excluded.

## API

All three are `GET`, admin-only, version-scoped (404 on a cross-version id), and accept the shared
query (`from`, `to`, `tagIds`). Rate limiting is the automatic section cap (read-only, no sub-cap).

| Endpoint                                   | Returns                       |
| ------------------------------------------ | ----------------------------- |
| `…/versions/[vid]/analytics/distributions` | `QuestionDistributionsResult` |
| `…/versions/[vid]/analytics/funnel`        | `CompletionFunnelResult`      |
| `…/versions/[vid]/analytics/cost`          | `QuestionnaireCostResult`     |

Endpoint builders: `API.APP.QUESTIONNAIRES.versionAnalytics{Distributions,Funnel,Cost}(id, vid)`.

## Exports (F8.2)

The record-level companion to the aggregate views above: download a version's **completed**
session results. Two buttons on the analytics page (`export-buttons.tsx`, next to the version
selector) hit one route, carrying the **same `from`/`to`/`tagIds` filter** the page is showing — so
an export matches the view.

| Format   | Shape                                                                                   |
| -------- | --------------------------------------------------------------------------------------- |
| **CSV**  | One row per session × question (every question; unanswered slots are empty value cells) |
| **JSON** | The full session graph — answers + provenance + per-turn transcript                     |

- **Scope** — only **completed**, non-preview sessions whose `createdAt` falls in the window. Status
  is still surfaced as a column/field. Capped at `MAX_EXPORT_SESSIONS` (5000); over-cap exports set
  `capped: true` (JSON) and log a warning.
- **CSV** is the lossy, spreadsheet-friendly view: every cell is run through `csvEscape`
  (RFC-4180 + formula-injection guard). Booleans render `true`/`false`, multi-choice joins with `, `.
- **JSON** is the faithful, machine-readable graph, returned **bare** (no API success envelope) so the
  downloaded file is the data itself.

**Anonymous-mode contract.** When the version's `AppQuestionnaireConfig.anonymousMode = true`, the
loader nulls every `respondentName` **and** drops every session's `turns` array (raw respondent
messages never reach the export). Honoured at the data boundary (`results-loader.ts`), not just the
UI. Answer _values_ are always present in both formats — anonymity is about not linking data to a
person, not redacting the survey data (mirrors the F7.4 PDF export).

| Endpoint                  | Query                            | Returns                         |
| ------------------------- | -------------------------------- | ------------------------------- |
| `…/versions/[vid]/export` | `from`, `to`, `tagIds`, `format` | CSV text / `ResultsExportModel` |

`format=csv\|json` (default `json`). Admin-only, version-scoped, master-flag-gated. Bulk read — a
dedicated `exportLimiter` sub-cap (10/min/user) on top of the section tier. Endpoint builder:
`API.APP.QUESTIONNAIRES.versionExport(id, vid)`. Source: `lib/app/questionnaire/export/results-*.ts`
and `app/api/v1/app/questionnaires/[id]/versions/[vid]/export/route.ts`.
