/**
 * Shared query contract + scope resolution for the F8.1 analytics endpoints.
 *
 * The three GET routes (distributions / funnel / cost) accept the same filter:
 * a date window and an optional tag filter. The window defaults reuse the
 * platform's analytics helpers (`lib/orchestration/analytics`) so the
 * questionnaire surface and the orchestration surface share one "last 30 days"
 * definition.
 *
 * `tagIds` arrives as a single comma-separated query param (the route layer
 * flattens repeated params to last-value-wins; see `validateQueryParams`), so we
 * split it here into the array the aggregators consume.
 */

import { z } from 'zod';

import {
  resolveAnalyticsDateRange,
  getAnalyticsDefaultDateInputs,
} from '@/lib/orchestration/analytics/date-range';

/** Validated raw query for any of the three analytics endpoints. */
export const questionnaireAnalyticsQuerySchema = z.object({
  /** Inclusive lower bound, `YYYY-MM-DD`. Defaults to 30 days before `to`. */
  from: z.string().date().optional(),
  /** Upper bound, `YYYY-MM-DD`. Defaults to now. */
  to: z.string().date().optional(),
  /** Comma-separated `AppQuestionTag` ids; restricts the distributions view. */
  tagIds: z.string().optional(),
  /**
   * Cohorts & Rounds scope. Absent = all sessions (the mixed, version-wide view). A round id =
   * ONLY that round's sessions (so one cohort's run of a questionnaire is analysed in isolation,
   * never blended with another cohort's round). The literal `none` = only non-round (open-ended)
   * sessions.
   */
  roundId: z.string().min(1).max(64).optional(),
});

export type QuestionnaireAnalyticsQuery = z.infer<typeof questionnaireAnalyticsQuerySchema>;

/**
 * The resolved scope the aggregators take: a concrete date window (Date objects),
 * the target version, and the parsed tag filter. `from`/`to` follow
 * {@link resolveAnalyticsDateRange} (inclusive `from`, exclusive `to`).
 */
export interface AnalyticsScope {
  versionId: string;
  from: Date;
  to: Date;
  /** Empty array = no tag filter (all questions). */
  tagIds: string[];
  /** Round scope: `undefined` = all sessions; `'none'` = open-ended only; else a round id. */
  roundId?: string;
}

/** Build a concrete {@link AnalyticsScope} from a validated query + version id. */
export function resolveAnalyticsScope(
  versionId: string,
  query: QuestionnaireAnalyticsQuery
): AnalyticsScope {
  const { from, to } = resolveAnalyticsDateRange(query);
  const tagIds = (query.tagIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return { versionId, from, to, tagIds, roundId: query.roundId };
}

/**
 * The Prisma `where` fragment a round scope contributes to a SESSION (or round-aware invitation)
 * query. `undefined` → no constraint (all sessions); `'none'` → only non-round sessions
 * (`roundId: null`); a round id → only that round. Spread into the aggregators' `where` so every
 * view scopes identically — one cohort's round is never blended with another's.
 */
export function roundSessionFilter(roundId: string | undefined): {
  roundId?: string | null;
} {
  if (roundId === undefined) return {};
  if (roundId === 'none') return { roundId: null };
  return { roundId };
}

/** `YYYY-MM-DD` defaults for the filter's `<input type="date">` controls. */
export { getAnalyticsDefaultDateInputs };
