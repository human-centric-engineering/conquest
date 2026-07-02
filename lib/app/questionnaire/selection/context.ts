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

/**
 * The narrow slice these coverage helpers actually read — the questions, the
 * answers, and the config. A {@link SelectionContext} satisfies it structurally
 * (so every F4.1 caller is unaffected), and F4.5's `CompletionContext` reuses the
 * same helpers without dragging in `round`/`sessionId`/`recentMessages`, which
 * coverage math never touches.
 */
export type CoverageContext = Pick<SelectionContext, 'questions' | 'answered' | 'config'>;

/** The set of `QuestionView.id`s that already have an answer this session. */
export function answeredQuestionIds(ctx: Pick<CoverageContext, 'answered'>): Set<string> {
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
export function unansweredQuestions(
  ctx: Pick<CoverageContext, 'questions' | 'answered'>
): QuestionView[] {
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
export function answeredCount(ctx: Pick<CoverageContext, 'answered'>): number {
  return answeredQuestionIds(ctx).size;
}

/**
 * Weighted coverage in [0, 1]: answered weight ÷ total weight. A version with no
 * questions is trivially fully covered (returns 1). When questions exist but
 * every weight is ≤ 0, weight can't measure coverage, so this falls back to a
 * count ratio (distinct answered ÷ question count) rather than reporting a
 * never-asked questionnaire as 100% done.
 */
export function coverageRatio(ctx: Pick<CoverageContext, 'questions' | 'answered'>): number {
  return weightedCoverage(ctx.questions, answeredQuestionIds(ctx));
}

/**
 * The structural core of {@link coverageRatio}: weighted coverage in [0, 1] from the minimal
 * `{ id, weight }` question shape and the set of answered ids. Exported so a non-selection caller
 * (the respondent answer panel) can report the SAME question-completeness figure the reasoning
 * trace shows — without assembling a full {@link SelectionContext}. Same fallbacks as
 * {@link coverageRatio}: an empty version is fully covered (1); when questions exist but no weight
 * is usable, it falls back to the distinct-answered count ratio.
 */
export function weightedCoverage(
  questions: ReadonlyArray<{ id: string; weight: number }>,
  answeredIds: ReadonlySet<string>
): number {
  let total = 0;
  const weightById = new Map<string, number>();
  for (const q of questions) {
    const w = Number.isFinite(q.weight) && q.weight > 0 ? q.weight : 0;
    weightById.set(q.id, w);
    total += w;
  }

  if (total <= 0) {
    // No usable weights: empty version → fully covered; else count-based.
    return questions.length === 0 ? 1 : Math.min(1, answeredIds.size / questions.length);
  }

  let covered = 0;
  for (const id of answeredIds) {
    covered += weightById.get(id) ?? 0;
  }
  return Math.min(1, covered / total);
}

/**
 * Fraction of a question's weight that a below-floor ("tentative") answer earns toward the
 * DISPLAY coverage figure. A confirmed answer — confidence ≥ the completion floor, or unscored
 * (authoritative respondent edit / non-opportunistic capture) — earns full credit (1.0); a
 * tentative one earns this. Progress-bar-only nuance: the completion GATE
 * ({@link answeredCount} / {@link coverageRatio}) never sees it, so tentative captures still
 * cannot unlock submission or satisfy a required question. Default 0.5 — half credit — so a
 * session mid-capture shows real momentum instead of a flat 0%.
 */
export const TENTATIVE_ANSWER_CREDIT = 0.5;

/**
 * Graded weighted coverage in [0, 1] for the progress DISPLAY only — never a gate input.
 *
 * Same weighting as {@link weightedCoverage}, but each distinct answered question contributes
 * `weight × credit` rather than its full weight: an answer at or above `floor` (or unscored, i.e.
 * authoritative) earns full credit (1.0); one below `floor` earns `tentativeCredit` (default
 * {@link TENTATIVE_ANSWER_CREDIT}). Where a question carries several answer rows, its best credit
 * wins (mirroring the distinct-question dedup {@link answeredCount} / {@link weightedCoverage} use).
 *
 * With `floor <= 0` every scored answer clears the bar, so this collapses to {@link weightedCoverage}
 * — the graded bar and the strict gate agree, preserving the "floor off ⇒ prior behaviour" contract.
 * Same fallbacks: an empty version is fully covered (1); when questions exist but no weight is usable,
 * it falls back to a credited count ratio (Σ credit over answered ÷ question count).
 */
export function gradedCoverage(
  questions: ReadonlyArray<{ id: string; weight: number }>,
  answered: ReadonlyArray<{ questionId: string; confidence: number | null }>,
  floor: number,
  tentativeCredit: number = TENTATIVE_ANSWER_CREDIT
): number {
  // Full credit for a confirmed (≥ floor) or unscored/authoritative (null) answer; partial otherwise.
  const creditFor = (confidence: number | null): number =>
    confidence === null || confidence >= floor ? 1 : tentativeCredit;

  // Best credit per DISTINCT question — a later corroborating row must never lower an earlier one.
  const bestCredit = new Map<string, number>();
  for (const a of answered) {
    const c = creditFor(a.confidence);
    const prev = bestCredit.get(a.questionId);
    if (prev === undefined || c > prev) bestCredit.set(a.questionId, c);
  }

  let total = 0;
  const weightById = new Map<string, number>();
  for (const q of questions) {
    const w = Number.isFinite(q.weight) && q.weight > 0 ? q.weight : 0;
    weightById.set(q.id, w);
    total += w;
  }

  if (total <= 0) {
    if (questions.length === 0) return 1;
    let credited = 0;
    for (const [id, credit] of bestCredit) {
      if (weightById.has(id)) credited += credit; // only real questions count toward the ratio
    }
    return Math.min(1, credited / questions.length);
  }

  let covered = 0;
  for (const [id, credit] of bestCredit) {
    covered += (weightById.get(id) ?? 0) * credit;
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
