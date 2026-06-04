/**
 * Pure helpers shared by every selection strategy (F4.1).
 *
 * These derive the common facts a strategy needs — which questions remain, how
 * much weighted coverage is done, whether the session has hit its terminal
 * condition — from an in-memory {@link SelectionContext}. No Prisma, no
 * randomness, no I/O: same input, same output, so the strategies built on top
 * stay exhaustively unit-testable.
 */

import type {
  QuestionView,
  SelectionContext,
  SelectionDecision,
} from '@/lib/app/questionnaire/selection/types';

/** The set of `QuestionView.id`s that already have an answer this session. */
export function answeredQuestionIds(ctx: SelectionContext): Set<string> {
  return new Set(ctx.answered.map((a) => a.questionId));
}

/**
 * Deterministic question ordering: section ordinal, then in-section ordinal,
 * then id as a final tiebreak so two slots that somehow share both ordinals
 * still sort stably (sort stability alone can't be relied on across engines).
 */
export function compareQuestions(a: QuestionView, b: QuestionView): number {
  if (a.sectionOrdinal !== b.sectionOrdinal) return a.sectionOrdinal - b.sectionOrdinal;
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Unanswered questions in deterministic order (a fresh, safely-sortable copy). */
export function unansweredQuestions(ctx: SelectionContext): QuestionView[] {
  const answered = answeredQuestionIds(ctx);
  return ctx.questions
    .filter((q) => !answered.has(q.id))
    .slice()
    .sort(compareQuestions);
}

/**
 * Required-before-optional precedence: the required subset if any required
 * question is unanswered, otherwise the whole pool. Lets `random`/`weighted`
 * exhaust mandatory questions before touching optional ones, while `sequential`
 * (which ignores this) keeps strict document order.
 */
export function requiredFirstPool(pool: QuestionView[]): QuestionView[] {
  const required = pool.filter((q) => q.required);
  return required.length > 0 ? required : pool;
}

/**
 * How many *distinct* questions have been answered this session. Deduplicated by
 * question id (matching {@link coverageRatio}'s guard) so a caller that supplies
 * two answer rows for the same question can't double-count toward the per-session
 * cap or `minQuestionsAnswered`.
 */
export function answeredCount(ctx: SelectionContext): number {
  return answeredQuestionIds(ctx).size;
}

/**
 * Weighted coverage in [0, 1]: answered weight ÷ total weight. A version with no
 * questions is trivially fully covered (returns 1). When questions exist but
 * every weight is ≤ 0, weight can't measure coverage, so this falls back to a
 * count ratio (distinct answered ÷ question count) rather than reporting a
 * never-asked questionnaire as 100% done.
 */
export function coverageRatio(ctx: SelectionContext): number {
  let total = 0;
  const weightById = new Map<string, number>();
  for (const q of ctx.questions) {
    const w = Number.isFinite(q.weight) && q.weight > 0 ? q.weight : 0;
    weightById.set(q.id, w);
    total += w;
  }

  const answered = answeredQuestionIds(ctx);
  if (total <= 0) {
    // No usable weights: empty version → fully covered; else count-based.
    return ctx.questions.length === 0 ? 1 : Math.min(1, answered.size / ctx.questions.length);
  }

  let covered = 0;
  for (const id of answered) {
    covered += weightById.get(id) ?? 0;
  }
  return Math.min(1, covered / total);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Float tolerance for the coverage-vs-threshold comparison. Summing fractional
 * weights in two iteration orders (covered vs total) can leave a fully-answered
 * session at 0.9999999998 of itself, which would miss a `coverageThreshold` of 1
 * and mis-report a completed questionnaire as `none`. The epsilon closes that gap.
 */
const COVERAGE_EPSILON = 1e-9;

/**
 * The shared pre-pick check every strategy runs first. Returns a terminal
 * {@link SelectionDecision} when the session shouldn't (or can't) ask another
 * question, or `null` when the strategy should proceed to pick from the
 * remaining pool.
 *
 * Order matters:
 * 1. Hard cap (`maxQuestionsPerSession`) → `complete`, even if coverage is unmet.
 * 2. Thresholds met (coverage ≥ `coverageThreshold` **and** answered ≥
 *    `minQuestionsAnswered`) → `complete`.
 * 3. Nothing left to ask but thresholds unmet → `none` (engine resolves).
 */
export function terminalDecision(ctx: SelectionContext): SelectionDecision | null {
  const answered = answeredCount(ctx);
  const { maxQuestionsPerSession: cap, coverageThreshold, minQuestionsAnswered } = ctx.config;

  if (cap !== null && answered >= cap) {
    return {
      kind: 'complete',
      rationale: `Reached the per-session cap of ${cap} question${cap === 1 ? '' : 's'}.`,
    };
  }

  const coverage = coverageRatio(ctx);
  if (coverage + COVERAGE_EPSILON >= coverageThreshold && answered >= minQuestionsAnswered) {
    return {
      kind: 'complete',
      rationale: `Coverage ${pct(coverage)} meets the ${pct(coverageThreshold)} threshold with ${answered} answered (min ${minQuestionsAnswered}).`,
    };
  }

  if (unansweredQuestions(ctx).length === 0) {
    return {
      kind: 'none',
      rationale: `No questions remain, but completion is unmet (need ≥${minQuestionsAnswered} answered at ≥${pct(coverageThreshold)} coverage; have ${answered} at ${pct(coverage)}).`,
    };
  }

  return null;
}
