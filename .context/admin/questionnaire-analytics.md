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
