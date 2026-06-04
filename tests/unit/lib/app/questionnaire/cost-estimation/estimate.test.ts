/**
 * Unit test: pre-launch cost estimator (F3.3).
 *
 * Exercises the pure `estimateSessionCost` / `effectiveQuestionsPerSession`
 * math: cap/floor clamping, the quadratic conversation-history term, respondent
 * scaling, the pricing-unknown contract, and the zero-question path. No I/O — the
 * route's DB/registry plumbing is covered by the integration test.
 */

import { describe, it, expect } from 'vitest';

import {
  estimateSessionCost,
  effectiveQuestionsPerSession,
  OUTPUT_TOKENS_PER_TURN,
  type EstimateSessionCostInput,
} from '@/lib/app/questionnaire/cost-estimation';

/** A priced, mid-size base input; override per case. */
function input(overrides: Partial<EstimateSessionCostInput> = {}): EstimateSessionCostInput {
  return {
    questionCount: 10,
    promptTokensTotal: 10 * 40, // ~40 tokens/question
    maxQuestionsPerSession: null,
    minQuestionsAnswered: 0,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    model: 'claude-sonnet-4-6',
    respondents: 1,
    ...overrides,
  };
}

describe('effectiveQuestionsPerSession', () => {
  it('asks every question when there is no cap', () => {
    expect(
      effectiveQuestionsPerSession({
        questionCount: 12,
        maxQuestionsPerSession: null,
        minQuestionsAnswered: 0,
      })
    ).toBe(12);
  });

  it('clamps to the per-session cap', () => {
    expect(
      effectiveQuestionsPerSession({
        questionCount: 30,
        maxQuestionsPerSession: 8,
        minQuestionsAnswered: 0,
      })
    ).toBe(8);
  });

  it('never exceeds the number of questions that exist', () => {
    expect(
      effectiveQuestionsPerSession({
        questionCount: 4,
        maxQuestionsPerSession: 20,
        minQuestionsAnswered: 0,
      })
    ).toBe(4);
  });

  it('raises a cap-reduced count up to the completion floor', () => {
    // cap says 3, but the floor says answer at least 6 → 6.
    expect(
      effectiveQuestionsPerSession({
        questionCount: 10,
        maxQuestionsPerSession: 3,
        minQuestionsAnswered: 6,
      })
    ).toBe(6);
  });

  it('bounds the floor by the number of questions', () => {
    expect(
      effectiveQuestionsPerSession({
        questionCount: 5,
        maxQuestionsPerSession: 2,
        minQuestionsAnswered: 99,
      })
    ).toBe(5);
  });

  it('is zero when there are no questions', () => {
    expect(
      effectiveQuestionsPerSession({
        questionCount: 0,
        maxQuestionsPerSession: null,
        minQuestionsAnswered: 3,
      })
    ).toBe(0);
  });
});

describe('estimateSessionCost', () => {
  it('produces an ordered low < mid < high band for a priced version', () => {
    const e = estimateSessionCost(input());
    expect(e.basedOn).toBe('heuristic');
    expect(e.pricingKnown).toBe(true);
    expect(e.perSession.lowUsd).toBeLessThan(e.perSession.midUsd);
    expect(e.perSession.midUsd).toBeLessThan(e.perSession.highUsd);
    expect(e.perSession.midUsd).toBeGreaterThan(0);
  });

  it('scales the per-questionnaire figure linearly with respondents', () => {
    const one = estimateSessionCost(input({ respondents: 1 }));
    const fifty = estimateSessionCost(input({ respondents: 50 }));
    expect(fifty.respondents).toBe(50);
    expect(fifty.perSession.midUsd).toBeCloseTo(one.perSession.midUsd, 10); // per-session unchanged
    expect(fifty.perQuestionnaire.midUsd).toBeCloseTo(one.perSession.midUsd * 50, 6);
  });

  it('coerces a sub-1 / fractional respondent count up to 1', () => {
    const e = estimateSessionCost(input({ respondents: 0 }));
    expect(e.respondents).toBe(1);
    expect(e.perQuestionnaire.midUsd).toBeCloseTo(e.perSession.midUsd, 10);
  });

  it('collapses a non-finite respondent count to 1 (no NaN/Infinity in USD)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const e = estimateSessionCost(input({ respondents: bad }));
      expect(e.respondents).toBe(1);
      expect(Number.isFinite(e.perQuestionnaire.midUsd)).toBe(true);
      expect(e.perQuestionnaire.midUsd).toBeCloseTo(e.perSession.midUsd, 10);
    }
  });

  it('grows input tokens super-linearly with question count (history term)', () => {
    // The quadratic transcript-replay term means doubling the questions more than
    // doubles the per-session input tokens.
    const ten = estimateSessionCost(input({ questionCount: 10, promptTokensTotal: 400 }));
    const twenty = estimateSessionCost(input({ questionCount: 20, promptTokensTotal: 800 }));
    expect(twenty.assumptions.inputTokensPerSession).toBeGreaterThan(
      2 * ten.assumptions.inputTokensPerSession
    );
  });

  it('applies the cap to the asked-question count', () => {
    const e = estimateSessionCost(input({ questionCount: 40, maxQuestionsPerSession: 5 }));
    expect(e.assumptions.effectiveQuestionsPerSession).toBe(5);
  });

  it('withholds USD when the model has no registry price', () => {
    const e = estimateSessionCost(input({ inputCostPerMillion: null }));
    expect(e.pricingKnown).toBe(false);
    expect(e.perSession.midUsd).toBe(0);
    expect(e.perQuestionnaire.midUsd).toBe(0);
    expect(e.notes).toMatch(/no registry price/i);
    // Token volume is still estimated even when USD is withheld.
    expect(e.assumptions.inputTokensPerSession).toBeGreaterThan(0);
  });

  it('treats a zero rate as pricing-unknown (registry $0 ≠ free)', () => {
    const e = estimateSessionCost(input({ outputCostPerMillion: 0 }));
    expect(e.pricingKnown).toBe(false);
    expect(e.perSession.midUsd).toBe(0);
  });

  it('returns an all-zero estimate with an explanatory note for an empty version', () => {
    const e = estimateSessionCost(input({ questionCount: 0, promptTokensTotal: 0 }));
    expect(e.assumptions.effectiveQuestionsPerSession).toBe(0);
    expect(e.perSession).toEqual({ lowUsd: 0, midUsd: 0, highUsd: 0 });
    expect(e.notes).toMatch(/no questions/i);
  });

  it('echoes the resolved model and effective question count in assumptions', () => {
    const e = estimateSessionCost(input({ model: 'gpt-4o-mini', questionCount: 7 }));
    expect(e.model).toBe('gpt-4o-mini');
    expect(e.assumptions.questionCount).toBe(7);
    expect(e.assumptions.effectiveQuestionsPerSession).toBe(7);
    // Output tokens follow the formula q × OUTPUT_TOKENS_PER_TURN, not just "non-zero".
    expect(e.assumptions.outputTokensPerSession).toBe(7 * OUTPUT_TOKENS_PER_TURN);
  });
});
