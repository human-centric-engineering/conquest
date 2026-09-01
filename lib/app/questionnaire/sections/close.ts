/**
 * Sectioned interviews (P21) — when may this section be closed?
 *
 * The section-scale twin of F4.5's completion gate, and deliberately a THIN wrapper over it rather
 * than a second implementation. `assessCompletion` already encodes four things this needs and would
 * otherwise have to restate:
 *
 *  1. the ordering that is load-bearing (cap, then the required gate, then the thresholds),
 *  2. the per-question confidence floor, so a tentative capture cannot close a section out,
 *  3. `COVERAGE_EPSILON`, so a weighted sum that lands a float-hair short still counts, and
 *  4. `capReached`, which is exactly the escape hatch a per-section turn cap needs.
 *
 * Restating any of them here would create two answers to one question, and they would drift. So the
 * only work this module does is build a narrowed {@link CompletionContext} and substitute the
 * section thresholds for the version ones.
 *
 * Pure: no Prisma, no Next, no I/O.
 */

import { assessCompletion } from '@/lib/app/questionnaire/completion/completion-logic';
import type {
  CompletionAssessment,
  CompletionContext,
} from '@/lib/app/questionnaire/completion/types';
import type { SectionedInterviewSettings } from '@/lib/app/questionnaire/sections/settings';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/** What {@link assessSectionCompletion} reads. */
export interface SectionCloseContext {
  section: InterviewSection;
  /** Every question in the version. Narrowed to the section's membership here. */
  questions: readonly QuestionView[];
  /** Every answer captured this session. Narrowed alongside the questions. */
  answered: readonly AnsweredView[];
  /** The version's resolved config. Its section block supplies the thresholds. */
  config: QuestionnaireConfigShape;
  settings: SectionedInterviewSettings;
  /** Turns spent in this section so far, for the `maxTurnsPerSection` cap. */
  turnsInSection: number;
  sessionId: string;
}

/** The verdict, plus the two things a surface needs that the raw assessment does not carry. */
export interface SectionCloseAssessment {
  /** The underlying completion assessment, over the section's questions alone. */
  assessment: CompletionAssessment;
  /** Whether the respondent's "move on" control should be unlocked. */
  canClose: boolean;
  /**
   * True when the ONLY thing holding this section open is an unanswered required question.
   *
   * Surfaced separately because it is the one state a respondent can be stuck in and the copy has to
   * name it ("one thing still needed here"). A generic "not yet" would leave them pressing a control
   * that will never unlock without telling them what to do.
   */
  blockedOnRequired: boolean;
}

/**
 * Substitute the section thresholds for the version ones.
 *
 * `maxQuestionsPerSession` is deliberately mapped from `maxTurnsPerSection`. It is the field
 * `assessCompletion` reads to set `capReached`, and `capReached` is precisely the "this may always
 * be closed now" signal the per-section cap exists to produce. Passing the turn count as the
 * answered count would corrupt coverage, so the cap is applied by the caller-side comparison below
 * instead and the config value is neutralised.
 */
function sectionConfig(
  config: QuestionnaireConfigShape,
  settings: SectionedInterviewSettings
): QuestionnaireConfigShape {
  return {
    ...config,
    coverageThreshold: settings.closeCoverage,
    minQuestionsAnswered: settings.closeMinAnswered,
    // Neutralised, and it must be `null` rather than `0`: the gate reads `cap !== null && answered
    // >= cap`, so a cap of zero is not "off", it fires on the very first assessment and reports
    // every section as ready to close before a word is said.
    //
    // Neutralised at all because the section cap counts TURNS while this one compares against
    // ANSWERS. Feeding one to the other would close a section the moment its answered count reached
    // a turn budget, which is a different thing. The turn cap is applied in `assessSectionCompletion`.
    maxQuestionsPerSession: null,
  };
}

/**
 * Assess whether one section may be closed.
 *
 * The gate is the version's own completion gate, run over the section's questions with the section's
 * thresholds. Two things sit outside it:
 *
 * - **The turn cap.** `maxTurnsPerSection` always unlocks the close, even below the coverage bar and
 *   even with a required question outstanding. That last part is deliberate and matches the
 *   early-finish escape hatch: without it, a sequential run meets a required question the respondent
 *   cannot or will not answer and has nowhere to go, neither closing the section nor leaving it.
 * - **A section with nothing in it.** Closeable immediately. It can only arise when scope narrowed a
 *   section to data slots with no mapped questions, and an empty gate that never opens would be a
 *   dead end produced by a configuration the respondent cannot see.
 */
export function assessSectionCompletion(ctx: SectionCloseContext): SectionCloseAssessment {
  const memberKeys = new Set(ctx.section.questionKeys);
  const questions = ctx.questions.filter((q) => memberKeys.has(q.key));
  // Answers are keyed by ROW ID (`AnsweredView.questionId`), not by slug, so the section's key
  // membership has to be resolved through the questions it just selected. Filtering the answers at
  // all matters: `assessCompletion` counts distinct answered questions, and leaving the whole
  // session's answers in would make every section read as more complete than it is.
  const memberIds = new Set(questions.map((q) => q.id));
  const answered = ctx.answered.filter((a) => memberIds.has(a.questionId));

  const completionContext: CompletionContext = {
    questions,
    answered: [...answered],
    config: sectionConfig(ctx.config, ctx.settings),
    sessionId: ctx.sessionId,
  };

  const assessment = assessCompletion(completionContext);

  const capReached =
    ctx.settings.maxTurnsPerSection > 0 && ctx.turnsInSection >= ctx.settings.maxTurnsPerSection;

  const blockedOnRequired = assessment.kind === 'blocked_on_required';

  return {
    // The cap is reported on the assessment too, so a caller reading `assessment.capReached` alone
    // (an admin timeline, a diagnostic) sees the same answer the control does.
    assessment: capReached ? { ...assessment, capReached: true } : assessment,
    canClose: questions.length === 0 || capReached || assessment.kind === 'offer',
    // A cap that has run out is not "blocked": the respondent can move on, they just did not satisfy
    // the requirement. Reporting both would make the UI say "one thing still needed" beside an
    // unlocked control.
    blockedOnRequired: blockedOnRequired && !capReached,
  };
}
