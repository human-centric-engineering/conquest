/**
 * Turn-evaluation output-contract tests.
 *
 * The verdict schema is the gate between a free-form LLM response and the typed verdict the
 * route returns and the drawer renders. These assert the headline scores/ratings are validated
 * (so a malformed score can never reach the UI), the prose fields accept markdown, and the
 * retry-message names the failed field paths.
 *
 * @see lib/app/questionnaire/turn-evaluation/schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  validateTurnEvaluation,
  buildTurnEvaluatorRetryMessage,
  turnEvaluationJsonSchema,
  type TurnEvaluation,
} from '@/lib/app/questionnaire/turn-evaluation/schema';

/** A minimal-but-complete valid verdict. */
function validVerdict(): TurnEvaluation {
  return {
    overallScore: 82,
    effectiveness: 'Good',
    calls: [
      {
        name: 'Answer extraction',
        purpose: 'Map answer to slots',
        score: 80,
        instructionCompliance: 'Followed the schema.',
        outputQuality: 'Correct.',
        risks: 'Low.',
        improvements: 'None.',
      },
    ],
    interviewer: {
      openEndedness: 8,
      singleTopicFocus: 9,
      nonLeading: 7,
      conversational: 8,
      cognitiveLoad: 9,
      specificity: 7,
      warmth: 8,
      stageAlignment: 8,
      violations: [],
    },
    extraction: {
      score: 84,
      confidenceQuality: 'reasonable',
      coverage: 'Housing slot.',
      missedSignals: 'None.',
      overreach: 'None.',
    },
    questionSelection: {
      score: 79,
      relevance: 'Built on the answer.',
      coverageStrategy: 'Advanced coverage.',
      timing: 'Right moment.',
      alternatives: 'Tenure.',
    },
    informationGain: { rating: 'Medium', analysis: 'One slot.' },
    missedOpportunities: 'Cost burden.',
    promptDrift: { rating: 'None', evidence: [] },
    efficiency: { rating: 'Good', analysis: 'Justified.' },
    summary: {
      strengths: ['Clear'],
      weaknesses: ['Leading'],
      biggestRisk: 'Over-inference',
      biggestOpportunity: 'Probe cost',
      recommendedAction: 'Tighten rubric',
    },
  };
}

describe('validateTurnEvaluation', () => {
  it('accepts a complete, in-range verdict', () => {
    const result = validateTurnEvaluation(validVerdict());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.overallScore).toBe(82);
      expect(result.value.effectiveness).toBe('Good');
    }
  });

  it('rejects an out-of-range overall score and reports the field path', () => {
    const bad = { ...validVerdict(), overallScore: 150 };
    const result = validateTurnEvaluation(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'overallScore')).toBe(true);
    }
  });

  it('rejects an interviewer sub-score below the 1–10 band', () => {
    const v = validVerdict();
    const bad = { ...v, interviewer: { ...v.interviewer, openEndedness: 0 } };
    const result = validateTurnEvaluation(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join('.') === 'interviewer.openEndedness')).toBe(
        true
      );
    }
  });

  it('rejects an unknown effectiveness/rating enum value', () => {
    const bad = { ...validVerdict(), effectiveness: 'Stellar' };
    expect(validateTurnEvaluation(bad).ok).toBe(false);
  });

  it('rejects a missing required section', () => {
    const v = validVerdict() as Record<string, unknown>;
    delete v.summary;
    expect(validateTurnEvaluation(v).ok).toBe(false);
  });
});

describe('buildTurnEvaluatorRetryMessage', () => {
  it('names the failed field paths when provided', () => {
    const msg = buildTurnEvaluatorRetryMessage(['overallScore', 'interviewer.warmth']);
    expect(msg).toContain('overallScore');
    expect(msg).toContain('interviewer.warmth');
    expect(msg).toMatch(/JSON/i);
  });

  it('omits the field list when there are no known paths', () => {
    const msg = buildTurnEvaluatorRetryMessage([]);
    expect(msg).toMatch(/JSON/i);
    expect(msg).not.toContain('invalid fields');
  });
});

describe('turnEvaluationJsonSchema', () => {
  it('is a serialisable object schema (usable as a provider responseFormat)', () => {
    expect(turnEvaluationJsonSchema).toMatchObject({ type: 'object' });
    expect(() => JSON.stringify(turnEvaluationJsonSchema)).not.toThrow();
  });
});
