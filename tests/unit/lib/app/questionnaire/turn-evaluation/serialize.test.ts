/**
 * Turn-evaluation Markdown serializer tests.
 *
 * The serializer is the single source of truth for the Copy and Download affordances, so it
 * must render every section faithfully and degrade empty fields to an em-dash rather than a
 * blank. These assert the section headings, the headline numbers, the per-call blocks, and the
 * empty-list handling.
 *
 * @see lib/app/questionnaire/turn-evaluation/serialize.ts
 */

import { describe, it, expect } from 'vitest';

import { serializeTurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/serialize';
import type { TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/schema';

function verdict(overrides: Partial<TurnEvaluation> = {}): TurnEvaluation {
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
        improvements: 'Tighten rubric.',
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
      violations: ['Slightly leading phrasing'],
    },
    extraction: {
      score: 84,
      confidenceQuality: 'reasonable',
      coverage: 'Housing slot captured.',
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
    informationGain: { rating: 'Medium', analysis: 'One slot filled.' },
    missedOpportunities: 'Cost burden follow-up.',
    promptDrift: { rating: 'None', evidence: [] },
    efficiency: { rating: 'Good', analysis: 'Two calls, justified.' },
    summary: {
      strengths: ['Clear question'],
      weaknesses: ['Leading'],
      biggestRisk: 'Over-inference',
      biggestOpportunity: 'Probe cost burden',
      recommendedAction: 'Tighten the extractor rubric',
    },
    ...overrides,
  };
}

describe('serializeTurnEvaluation', () => {
  it('renders the turn heading with the 1-based turn number', () => {
    const md = serializeTurnEvaluation(verdict(), 0);
    expect(md).toContain('# Turn 1 — Evaluation');
  });

  it('renders every spec section heading and the headline numbers', () => {
    const md = serializeTurnEvaluation(verdict(), 2);
    expect(md).toContain('# Turn 3 — Evaluation');
    for (const heading of [
      '## Overall Turn Assessment',
      '## Call-by-Call Evaluation',
      '## Interviewer Evaluation',
      '## Extraction Evaluation',
      '## Question Selection Evaluation',
      '## Information Gain Analysis',
      '## Missed Opportunity Analysis',
      '## Prompt Drift Analysis',
      '## Cost and Efficiency Analysis',
      '## Turn Summary',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Overall Score: 82');
    expect(md).toContain('Effectiveness: Good');
    expect(md).toContain('Extraction Score: 84');
    expect(md).toContain('Question Selection Score: 79');
  });

  it('renders each call block with its score and the four facets', () => {
    const md = serializeTurnEvaluation(verdict(), 0);
    expect(md).toContain('### Answer extraction  (Score: 80)');
    expect(md).toContain('**Instruction Compliance**');
    expect(md).toContain('**Output Quality**');
    expect(md).toContain('**Risks**');
    expect(md).toContain('**Improvements**');
  });

  it('renders interviewer sub-scores and a violation bullet', () => {
    const md = serializeTurnEvaluation(verdict(), 0);
    expect(md).toContain('- Open-endedness: 8');
    expect(md).toContain('- Slightly leading phrasing');
  });

  it('degrades empty lists and blank prose to an em-dash', () => {
    const md = serializeTurnEvaluation(
      verdict({
        calls: [],
        promptDrift: { rating: 'None', evidence: [] },
        missedOpportunities: '   ',
      }),
      0
    );
    // Call-by-call with no calls, prompt-drift evidence, and blank missed-opps all show "—".
    expect(md).toContain('## Call-by-Call Evaluation\n—');
    expect(md).toContain('Evidence:\n—');
    expect(md).toContain('## Missed Opportunity Analysis\n—');
  });
});
