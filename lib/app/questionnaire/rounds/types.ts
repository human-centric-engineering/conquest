/**
 * Cohorts & Rounds — status vocabularies + client-safe view contracts.
 *
 * Pure types, no Prisma / Next / server-only imports, so the route serializers and the
 * `'use client'` table/form components share one contract (the demo-clients `views.ts`
 * precedent). Dates cross the HTTP boundary as ISO strings.
 *
 * Status tuples are `const` tuples for the same single-source reason as
 * {@link SESSION_STATUSES} elsewhere: the schema's `status` column, the Zod enum, and any
 * UI filter all derive from the one tuple. Validated at the boundary with `narrowToEnum`.
 */

/**
 * A cohort member's roster state. `active` members may access an open round; `removed`
 * members are revoked WITHOUT deleting the row, so any session that points back to them
 * survives (the schema keeps `@default("active")`).
 */
export const COHORT_MEMBER_STATUSES = ['active', 'removed'] as const;
export type CohortMemberStatus = (typeof COHORT_MEMBER_STATUSES)[number];

/**
 * A round's lifecycle. `draft` → not yet delivering (no access); `open` → live within its
 * window; `closed` → finished (manual close, or simply no longer open). A session is
 * gated by BOTH this status and the `opensAt`/`closesAt` window — an `open` round whose
 * `closesAt` has passed still denies access (the time-bound is the window, not the flag).
 */
export const ROUND_STATUSES = ['draft', 'open', 'closed'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/** Completion roll-up shared by the cohort + round list rows (computed by `_lib/stats.ts`). */
export interface RoundCompletionStats {
  /** Non-preview sessions started within the round (or across the cohort's rounds). */
  sessionsStarted: number;
  /** Of those, how many reached `completed`. */
  sessionsCompleted: number;
  /** completed / started, 0 when none started. Rounded to 2 dp by the serializer. */
  completionRate: number;
}

/** One row in the admin cohorts table (per demo client). */
export interface CohortView {
  id: string;
  demoClientId: string;
  name: string;
  description: string | null;
  /** Active members on the roster (removed members excluded from the headline count). */
  memberCount: number;
  /** Rounds belonging to this cohort. */
  roundCount: number;
  /** Completion across all of the cohort's rounds' sessions. */
  stats: RoundCompletionStats;
  createdAt: string;
  updatedAt: string;
}

/** One person on a cohort's roster. */
export interface CohortMemberView {
  id: string;
  cohortId: string;
  email: string;
  name: string;
  notes: string | null;
  status: CohortMemberStatus;
  addedAt: string;
  removedAt: string | null;
}

/** Cohort detail = the list row plus its roster. Rounds are loaded by the rounds list. */
export interface CohortDetail extends CohortView {
  members: CohortMemberView[];
}

/** One questionnaire offered within a round (a round-item row, enriched for display). */
export interface RoundQuestionnaireView {
  /** The round-item id (the detach handle). */
  itemId: string;
  questionnaireId: string;
  title: string;
  /** Optional pinned version; null = follows the questionnaire's current launched version. */
  versionId: string | null;
}

/** One row in the admin rounds table. */
export interface RoundView {
  id: string;
  cohortId: string;
  /** Denormalised for the cross-cohort rounds table (so the row shows which cohort). */
  cohortName: string;
  name: string;
  description: string | null;
  status: RoundStatus;
  opensAt: string | null;
  closesAt: string | null;
  closedAt: string | null;
  /** How many questionnaires the round bundles. */
  questionnaireCount: number;
  /** Active members of the round's cohort (the population the round is delivered to). */
  memberCount: number;
  stats: RoundCompletionStats;
  createdAt: string;
  updatedAt: string;
}

/** Round detail = the list row plus the bundled questionnaires. */
export interface RoundDetail extends RoundView {
  questionnaires: RoundQuestionnaireView[];
}
