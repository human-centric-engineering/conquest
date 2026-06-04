/**
 * Strategy: weighted.
 *
 * Scores each remaining question and asks the highest scorer. The score rewards
 * three things, multiplicatively:
 *   1. the admin-set `weight` (the base),
 *   2. being in an under-covered section (so attention spreads across sections
 *      rather than draining one before moving on), and
 *   3. sitting in a section that already holds a low-confidence answer (pull the
 *      conversation back to shaky ground).
 *
 * Required questions still come first (via `requiredFirstPool`); scoring only
 * orders *within* the chosen pool. Ties break on document order. Fully
 * deterministic — the tuning constants live in `../types`.
 */

import { registerStrategy } from '@/lib/app/questionnaire/selection/registry';
import {
  answeredCount,
  compareQuestions,
  requiredFirstPool,
  terminalDecision,
  unansweredQuestions,
} from '@/lib/app/questionnaire/selection/context';
import {
  LOW_CONFIDENCE_MULT,
  LOW_CONFIDENCE_THRESHOLD,
  UNDERCOVERED_SECTION_BONUS,
  type QuestionView,
  type SelectionContext,
  type SelectionDecision,
  type SelectionStrategyPlugin,
} from '@/lib/app/questionnaire/selection/types';

/** A candidate question paired with its computed score. */
export interface ScoredQuestion {
  question: QuestionView;
  score: number;
}

/**
 * Per-section facts the scorer needs, computed once per `select` call:
 * completion ratio and whether any low-confidence answer sits in the section.
 */
function sectionStats(
  ctx: SelectionContext
): Map<string, { answered: number; total: number; hasLowConfidence: boolean }> {
  const stats = new Map<string, { answered: number; total: number; hasLowConfidence: boolean }>();
  for (const q of ctx.questions) {
    const s = stats.get(q.sectionId) ?? { answered: 0, total: 0, hasLowConfidence: false };
    s.total += 1;
    stats.set(q.sectionId, s);
  }

  const sectionByQuestion = new Map(ctx.questions.map((q) => [q.id, q.sectionId]));
  const counted = new Set<string>();
  for (const a of ctx.answered) {
    if (counted.has(a.questionId)) continue; // dedup duplicate answer rows (matches coverageRatio)
    counted.add(a.questionId);
    const sectionId = sectionByQuestion.get(a.questionId);
    if (sectionId === undefined) continue; // answer for a question not in this version
    const s = stats.get(sectionId);
    if (!s) continue;
    s.answered += 1;
    if (a.confidence !== null && a.confidence <= LOW_CONFIDENCE_THRESHOLD) {
      s.hasLowConfidence = true;
    }
  }
  return stats;
}

/**
 * Score every unanswered question in the required-first pool, best-first (ties
 * broken by document order). Exported so the scoring math is directly
 * unit-testable without going through `select`.
 */
export function weightedScores(ctx: SelectionContext): ScoredQuestion[] {
  const pool = requiredFirstPool(unansweredQuestions(ctx));
  const stats = sectionStats(ctx);

  const scored = pool.map((question) => {
    const s = stats.get(question.sectionId);
    const inverseCompletion = s && s.total > 0 ? 1 - s.answered / s.total : 1;
    const lowConfidenceMult = s?.hasLowConfidence ? LOW_CONFIDENCE_MULT : 1;
    const base = Number.isFinite(question.weight) && question.weight > 0 ? question.weight : 0;
    const score = base * (1 + UNDERCOVERED_SECTION_BONUS * inverseCompletion) * lowConfidenceMult;
    return { question, score };
  });

  scored.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : compareQuestions(a.question, b.question)
  );
  return scored;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the plugin contract; body is sync.
async function select(ctx: SelectionContext): Promise<SelectionDecision> {
  const terminal = terminalDecision(ctx);
  if (terminal) return terminal;

  // terminalDecision returned null ⇒ the pool is non-empty.
  const top = weightedScores(ctx)[0];
  return {
    kind: 'ask' as const,
    questionId: top.question.id,
    rationale: `Highest weighted score ${top.score.toFixed(2)} for ${top.question.key} (weight ${top.question.weight}); ${answeredCount(ctx)} answered so far.`,
    costUsd: 0,
  };
}

export const weightedStrategy: SelectionStrategyPlugin = {
  slug: 'weighted',
  description:
    'Scores remaining questions by weight, section coverage, and low-confidence follow-up; asks the top scorer. Required first.',
  select,
};

registerStrategy(weightedStrategy);
