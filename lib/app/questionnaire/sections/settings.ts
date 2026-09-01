/**
 * Sectioned interviews (P21) — the version's settings block, and its read-path narrower.
 *
 * A Json blob on `AppQuestionnaireConfig` rather than a dozen scalar columns, the same judgement
 * `conditionalTopics`, `houseRules`, `respondentReport`, `cohortReport` and `intro` already make:
 * one coherent feature with a dozen knobs. Read through {@link narrowSectionedInterviewSettings},
 * never destructured raw.
 *
 * A leaf module, like `sections/types.ts` beside it — see that file's docblock for why importing
 * `lib/app/questionnaire/types.ts` from here would be a load-order crash rather than a style point.
 *
 * Pure: no Prisma, no Next. Safe to import from client components.
 */

import { isRecord } from '@/lib/utils';
import {
  SECTION_NAVIGATIONS,
  SECTION_SOURCES,
  SECTION_TANGENT_POLICIES,
  narrowSectionEnum,
  type SectionNavigation,
  type SectionSource,
  type SectionTangentPolicy,
} from '@/lib/app/questionnaire/sections/types';

/* -------------------------------------------------------------------------- */
/* Field bounds                                                               */
/* -------------------------------------------------------------------------- */

/** Coverage is a fraction, edited as a whole percent in the config editor (as early finish is). */
export const MIN_SECTION_CLOSE_COVERAGE = 0;
export const MAX_SECTION_CLOSE_COVERAGE = 1;

/** Answered-count bar. `0` means "not a criterion on that axis". */
export const MIN_SECTION_CLOSE_ANSWERED = 0;
export const MAX_SECTION_CLOSE_ANSWERED = 500;

/**
 * Bounds on the per-section turn cap. `0` is off, which is the default.
 *
 * The ceiling is deliberately generous rather than opinionated: it exists to stop a stored blob
 * carrying nonsense, not to express a view about how long a section should take.
 */
export const MIN_TURNS_PER_SECTION = 0;
export const MAX_TURNS_PER_SECTION = 200;

/* -------------------------------------------------------------------------- */
/* The settings                                                               */
/* -------------------------------------------------------------------------- */

/** The lazily-defaulted `sections` Json on `AppQuestionnaireConfig`. */
export interface SectionedInterviewSettings {
  /**
   * The master switch. **False by default.** While false nothing else here is read, the resolver is
   * never called, and the interview runs exactly as it did before this feature existed.
   */
  enabled: boolean;

  /**
   * Which grouping the sections come from, or `'auto'` to walk the ladder
   * (topics, then data-slot themes, then document sections). `'auto'` is the default because the
   * right answer changes as a questionnaire is authored: a version gains data slots after ingest and
   * may gain live topics months later, and an author should not have to come back and re-pick.
   */
  source: 'auto' | SectionSource;

  /** Whether a section must be finished before the next one opens. */
  navigation: SectionNavigation;

  /** What happens to an answer informing a section other than the active one. */
  tangentPolicy: SectionTangentPolicy;

  /**
   * Fraction of the section's in-scope questions that must be answered before the respondent's
   * "move on" control unlocks.
   *
   * Defaults to `1.0`, mirroring `earlyFinishMinCoverage`: the control surfaces once the section is
   * genuinely done, and an author lowers it to let respondents move on sooner. Stored as a fraction,
   * edited as a whole percent.
   */
  closeCoverage: number;

  /**
   * Answered-count bar, `0` = off. Off by default so the coverage bar gates alone.
   *
   * **BOTH bars must be met**, not either. This is the section-scale twin of the version's
   * `coverageThreshold` + `minQuestionsAnswered` pair, and it inherits their AND from
   * `assessCompletion` rather than restating the rule. Deliberately NOT the early-finish pair's OR:
   * early finish is a respondent's right to leave, so the loosest reading is correct there; this is
   * an author's statement about when a section is genuinely covered, so the strictest is.
   *
   * `0` is "not a criterion on that axis", which is why it is the default: an unset count bar must
   * not tighten a coverage bar the author did set.
   */
  closeMinAnswered: number;

  /**
   * Hard cap on turns spent in one section. `0` is off.
   *
   * This is the escape hatch, and it is the reason a sequential run cannot dead-end: a section
   * holding an unanswered required question is `blocked_on_required` and its gate can never clear,
   * so without a cap the respondent could neither close it nor leave it. Reaching the cap always
   * unlocks the close, through the same `capReached` path `assessCompletion` already has.
   */
  maxTurnsPerSection: number;

  /**
   * Let the interviewer OFFER the move, as well as the control appearing.
   *
   * On by default. The control alone is silent: a respondent who is not watching the composer for a
   * button appearing will simply keep answering a section that is finished.
   */
  agentOffersClose: boolean;

  /**
   * Show sections that are not yet reachable, greyed and unclickable.
   *
   * On by default. Under `sequential` navigation the tabs are the only place the respondent can see
   * the shape of what is coming, and hiding it makes the interview feel unbounded in exactly the way
   * this feature exists to fix.
   */
  showLockedSections: boolean;
}

/** The lazy default — what `{}` resolves to, and what a fresh version runs with. */
export const DEFAULT_SECTIONED_INTERVIEW_SETTINGS: SectionedInterviewSettings = {
  enabled: false,
  source: 'auto',
  navigation: 'sequential',
  tangentPolicy: 'capture',
  // 100%: the control surfaces once the section is genuinely covered. Authors lower it.
  closeCoverage: 1,
  // Off, so the coverage bar gates alone.
  closeMinAnswered: 0,
  // Off. See the field docblock for why an author running `sequential` should set one.
  maxTurnsPerSection: 0,
  agentOffersClose: true,
  showLockedSections: true,
};

/* -------------------------------------------------------------------------- */
/* Narrower                                                                   */
/* -------------------------------------------------------------------------- */

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Project the stored `sections` Json onto a complete {@link SectionedInterviewSettings}.
 *
 * Missing keys fall back to {@link DEFAULT_SECTIONED_INTERVIEW_SETTINGS}; unknown keys are dropped;
 * numbers are clamped rather than rejected. A malformed blob therefore degrades to "feature off",
 * which is the only safe direction for a setting that decides how a respondent moves through an
 * instrument: a half-read blob must never leave someone bounded to a section by a rule nobody wrote.
 */
export function narrowSectionedInterviewSettings(value: unknown): SectionedInterviewSettings {
  const obj = isRecord(value) ? value : {};
  const d = DEFAULT_SECTIONED_INTERVIEW_SETTINGS;

  const rawSource = typeof obj.source === 'string' ? obj.source : '';
  const source: 'auto' | SectionSource =
    rawSource === 'auto' ? 'auto' : narrowSectionEnum(rawSource, SECTION_SOURCES, 'auto');

  return {
    enabled: asBool(obj.enabled, d.enabled),
    // `narrowSectionEnum` cannot express the 'auto' union member, so it is checked first above and
    // is also the fallback: an unreadable source means "work it out", never a pinned grouping the
    // author did not choose.
    source,
    navigation: narrowSectionEnum(
      typeof obj.navigation === 'string' ? obj.navigation : '',
      SECTION_NAVIGATIONS,
      d.navigation
    ),
    tangentPolicy: narrowSectionEnum(
      typeof obj.tangentPolicy === 'string' ? obj.tangentPolicy : '',
      SECTION_TANGENT_POLICIES,
      d.tangentPolicy
    ),
    closeCoverage: asNumber(
      obj.closeCoverage,
      MIN_SECTION_CLOSE_COVERAGE,
      MAX_SECTION_CLOSE_COVERAGE,
      d.closeCoverage
    ),
    closeMinAnswered: Math.round(
      asNumber(
        obj.closeMinAnswered,
        MIN_SECTION_CLOSE_ANSWERED,
        MAX_SECTION_CLOSE_ANSWERED,
        d.closeMinAnswered
      )
    ),
    maxTurnsPerSection: Math.round(
      asNumber(
        obj.maxTurnsPerSection,
        MIN_TURNS_PER_SECTION,
        MAX_TURNS_PER_SECTION,
        d.maxTurnsPerSection
      )
    ),
    agentOffersClose: asBool(obj.agentOffersClose, d.agentOffersClose),
    showLockedSections: asBool(obj.showLockedSections, d.showLockedSections),
  };
}
