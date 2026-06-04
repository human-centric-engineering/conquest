/**
 * Pure pre-launch cost estimator (F3.3).
 *
 * `estimateSessionCost` takes only numbers — the route does all I/O (loading
 * slots, sizing prompts via `estimateTokens`, resolving pricing via `getModel`)
 * and passes the aggregates in. Prisma-free and Next-free, so it is exhaustively
 * unit-testable.
 *
 * See `./types` for the heuristic model and why it is heuristic-only.
 */

import {
  HISTORY_TOKENS_PER_PRIOR_TURN,
  OUTPUT_TOKENS_PER_TURN,
  RANGE_HIGH_FACTOR,
  RANGE_LOW_FACTOR,
  SYSTEM_PROMPT_TOKENS,
  type CostRange,
  type SessionCostEstimate,
} from '@/lib/app/questionnaire/cost-estimation/types';

export interface EstimateSessionCostInput {
  /** Total question slots in the version. */
  questionCount: number;
  /**
   * Sum of `estimateTokens(slot.prompt)` across the version's question slots.
   * Used to add the real question text into the per-turn input (averaged over
   * `questionCount` when the cap asks fewer than all questions).
   */
  promptTokensTotal: number;
  /** Config per-session question cap; `null` = ask every question. */
  maxQuestionsPerSession: number | null;
  /** Config completion floor; the session asks at least this many (capped by `questionCount`). */
  minQuestionsAnswered: number;
  /** Resolved per-million input price, or `null` when the model has no known price. */
  inputCostPerMillion: number | null;
  /** Resolved per-million output price, or `null` when the model has no known price. */
  outputCostPerMillion: number | null;
  /** Model slug pricing was resolved against. */
  model: string;
  /** Respondent count for the per-questionnaire figure (coerced to ≥ 1). */
  respondents: number;
}

const ZERO_RANGE: CostRange = { lowUsd: 0, midUsd: 0, highUsd: 0 };

/** Multiply every band of a cost range by a scalar (e.g. respondent count). */
export function scaleRange(range: CostRange, factor: number): CostRange {
  return {
    lowUsd: range.lowUsd * factor,
    midUsd: range.midUsd * factor,
    highUsd: range.highUsd * factor,
  };
}

/**
 * Effective questions asked per session: `min(questionCount, cap)`, but never
 * below `min(minQuestionsAnswered, questionCount)`. The floor can only raise a
 * cap-reduced count, and is itself bounded by how many questions exist.
 */
export function effectiveQuestionsPerSession(input: {
  questionCount: number;
  maxQuestionsPerSession: number | null;
  minQuestionsAnswered: number;
}): number {
  const { questionCount, maxQuestionsPerSession, minQuestionsAnswered } = input;
  if (questionCount <= 0) return 0;
  const capped =
    maxQuestionsPerSession === null
      ? questionCount
      : Math.min(questionCount, Math.max(0, maxQuestionsPerSession));
  const floor = Math.min(Math.max(0, minQuestionsAnswered), questionCount);
  return Math.max(capped, floor);
}

export function estimateSessionCost(input: EstimateSessionCostInput): SessionCostEstimate {
  // Coerce to a positive integer; non-finite / 0 / negative all collapse to 1, so a
  // bad respondent count from a non-HTTP caller can't propagate NaN/Infinity into USD.
  const flooredRespondents = Math.floor(input.respondents);
  const respondents =
    Number.isFinite(flooredRespondents) && flooredRespondents >= 1 ? flooredRespondents : 1;
  const pricingKnown =
    input.inputCostPerMillion !== null &&
    input.inputCostPerMillion > 0 &&
    input.outputCostPerMillion !== null &&
    input.outputCostPerMillion > 0;

  const q = effectiveQuestionsPerSession(input);

  // Average prompt tokens across the version's slots, charged once per asked turn.
  const avgPromptTokens =
    input.questionCount > 0 ? input.promptTokensTotal / input.questionCount : 0;

  // Input grows quadratically with q: each turn replays the transcript so far.
  // Σ over turns i=0..q-1 of i prior turns = q(q-1)/2.
  const historyTokens = (HISTORY_TOKENS_PER_PRIOR_TURN * q * (q - 1)) / 2;
  const inputTokensPerSession = q * (SYSTEM_PROMPT_TOKENS + avgPromptTokens) + historyTokens;
  const outputTokensPerSession = q * OUTPUT_TOKENS_PER_TURN;

  let perSession: CostRange = ZERO_RANGE;
  let notes: string;

  if (q === 0) {
    notes =
      'No questions in this version yet — add questions to estimate session cost. Heuristic estimate.';
  } else if (!pricingKnown) {
    notes = `No registry price is configured for "${input.model}". Token volume is estimated, but USD cannot be computed — set a price for the model to see a figure. Heuristic estimate.`;
  } else {
    const midUsd =
      (inputTokensPerSession / 1_000_000) * (input.inputCostPerMillion as number) +
      (outputTokensPerSession / 1_000_000) * (input.outputCostPerMillion as number);
    perSession = {
      lowUsd: midUsd * RANGE_LOW_FACTOR,
      midUsd,
      highUsd: midUsd * RANGE_HIGH_FACTOR,
    };
    notes = `Heuristic estimate over ${q} question${q === 1 ? '' : 's'} per session against "${input.model}" — no real session history exists yet (P6), so treat the range as indicative.`;
  }

  return {
    perSession,
    perQuestionnaire: scaleRange(perSession, respondents),
    respondents,
    basedOn: 'heuristic',
    pricingKnown,
    model: input.model,
    assumptions: {
      questionCount: input.questionCount,
      effectiveQuestionsPerSession: q,
      inputTokensPerSession,
      outputTokensPerSession,
      inputCostPerMillion: input.inputCostPerMillion,
      outputCostPerMillion: input.outputCostPerMillion,
    },
    notes,
  };
}
