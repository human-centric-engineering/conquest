import { describe, expect, it } from 'vitest';

import { ANSWER_PROVENANCES, EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import { applyRefinement } from '@/lib/app/questionnaire/refinement/refinement-logic';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';

import { existing } from '@/tests/unit/lib/app/questionnaire/refinement/_fixtures';

/**
 * F4.4 is the first and only consumer of the `refined` provenance label. These
 * assertions pin that contract: `refined` lives in the shared vocabulary, stays out
 * of the extractor's emittable subset, and is exactly what a `refine` produces.
 */
describe('answer-refinement provenance contract', () => {
  it('refined is in the vocabulary but not emittable by the F4.2 extractor', () => {
    expect(ANSWER_PROVENANCES).toContain('refined');
    expect([...EXTRACTOR_EMITTED_PROVENANCES]).not.toContain('refined');
  });

  it('a refine is the producer of the refined label', () => {
    const decision: RefinementDecision = {
      slotKey: 'a',
      action: 'refine',
      questionType: 'free_text',
      newValue: 'v2',
      rationale: 'evolved',
      source: 'clarification',
      confidence: 0.9,
    };
    const after = applyRefinement(
      existing({ slotKey: 'a', value: 'v1', provenance: 'direct' }),
      decision
    );
    expect(after.provenance).toBe('refined');
  });
});
