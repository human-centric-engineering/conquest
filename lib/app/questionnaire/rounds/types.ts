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

/**
 * Learning Mode tuning, persisted lazily on `AppQuestionnaireRound.learningConfig` (a `{}` JSON
 * column that resolves to {@link DEFAULT_LEARNING_CONFIG} at read time, mirroring
 * `AppQuestionnaireConfig`'s lazy-defaults pattern). Kept tiny on purpose — one knob today.
 */
export interface LearningConfigShape {
  /**
   * **k-anonymity threshold.** The minimum number of completed, non-preview respondents (in the
   * round, on the same version) before ANY generalised theme is surfaced — at both the round level
   * and per slot. Guards against de-anonymisation ("the one other person said X"). Default 3; the
   * UI enforces a floor of 2.
   */
  minRespondents: number;
}

/** Default Learning Mode tuning — applied when the round's `learningConfig` JSON is absent/`{}`. */
export const DEFAULT_LEARNING_CONFIG: LearningConfigShape = {
  minRespondents: 3,
};

/** Lower bound the UI + schema enforce on {@link LearningConfigShape.minRespondents}. */
export const MIN_RESPONDENTS_FLOOR = 2;

/**
 * Resolve the raw `learningConfig` JSON column (an opaque `{}` by default) to a fully-defaulted
 * {@link LearningConfigShape}. Pure + defensive: any missing/invalid field falls back to its default,
 * and `minRespondents` is clamped to the {@link MIN_RESPONDENTS_FLOOR} floor — the read path never
 * trusts a stored value below it. Mirrors how `AppQuestionnaireConfig` resolves an absent row.
 */
export function resolveLearningConfig(raw: unknown): LearningConfigShape {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const min = obj.minRespondents;
  const minRespondents =
    typeof min === 'number' && Number.isFinite(min)
      ? Math.max(MIN_RESPONDENTS_FLOOR, Math.floor(min))
      : DEFAULT_LEARNING_CONFIG.minRespondents;
  return { minRespondents };
}

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
  /**
   * Respondent intro background override (markdown). When non-empty, REPLACES the questionnaire-level
   * "about this questionnaire" text for this cohort's respondents; null inherits. Respondent-facing —
   * distinct from `description` (a private admin note).
   */
  introBackground: string | null;
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
  /** Additional Context ("interviewer briefing") on/off for this round (off by default). */
  contextEnabled: boolean;
  /** Learning Mode on/off for this round (off by default; introduces bias by design). */
  learningEnabled: boolean;
  /** Resolved Learning Mode tuning (defaults applied; never the raw `{}`). */
  learningConfig: LearningConfigShape;
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

/** How a briefing entry was authored — drives the admin-UI provenance badge. */
export type RoundContextSource = 'manual' | 'upload' | 'ai_suggested';

/** One question a briefing entry can be attributed to (the admin attribution picker's leaf). */
export interface BriefableQuestion {
  id: string;
  prompt: string;
  sectionTitle: string;
}

/**
 * A bundled questionnaire resolved to its effective version + briefable questions — the source for
 * the admin attribution picker. The admin picks a questionnaire (→ its `versionId`), then "General"
 * or one of its `questions`, when authoring a briefing entry.
 */
export interface BriefableQuestionnaire {
  questionnaireId: string;
  title: string;
  versionId: string;
  questions: BriefableQuestion[];
}

/**
 * One Additional Context ("interviewer briefing") entry, serialized for the admin UI. `questionSlotId`
 * null = a general entry (applies to the whole version); else attributed to one question.
 * `questionPrompt` is the denormalised prompt of the attributed question (null for general entries, or
 * when the question no longer exists after a version fork — an orphan the admin can re-attach).
 */
export interface RoundContextEntryView {
  id: string;
  roundId: string;
  versionId: string;
  questionSlotId: string | null;
  questionPrompt: string | null;
  title: string;
  content: string;
  source: RoundContextSource;
  ordinal: number;
  createdAt: string;
  updatedAt: string;
}
