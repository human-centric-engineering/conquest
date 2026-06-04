import { describe, it, expect } from 'vitest';
import {
  weightedScores,
  weightedStrategy,
} from '@/lib/app/questionnaire/selection/strategies/weighted';
import {
  LOW_CONFIDENCE_MULT,
  UNDERCOVERED_SECTION_BONUS,
} from '@/lib/app/questionnaire/selection/types';
import { ctx, q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

const select = weightedStrategy.select;

describe('weightedScores — scoring math', () => {
  it('scores an untouched single-question section as weight × (1 + bonus)', () => {
    const c = ctx({ questions: [q({ id: 'a', weight: 2 })] });
    const [top] = weightedScores(c);
    expect(top.question.id).toBe('a');
    // inverseCompletion = 1 → 2 × (1 + 0.5×1) × 1
    expect(top.score).toBeCloseTo(2 * (1 + UNDERCOVERED_SECTION_BONUS * 1));
  });

  it('favours the less-covered section over a heavier question in a covered one', () => {
    const c = ctx({
      questions: [
        // s1: two questions, one answered → inverseCompletion 0.5
        q({ id: 's1q1', sectionId: 's1', sectionOrdinal: 0, ordinal: 0, weight: 1 }),
        q({ id: 's1q2', sectionId: 's1', sectionOrdinal: 0, ordinal: 1, weight: 1 }),
        // s2: one untouched question → inverseCompletion 1
        q({ id: 's2q1', sectionId: 's2', sectionOrdinal: 1, ordinal: 0, weight: 1 }),
      ],
      answered: [{ questionId: 's1q1', confidence: null }],
    });
    const ranked = weightedScores(c).map((s) => s.question.id);
    expect(ranked[0]).toBe('s2q1');
  });

  it('applies the low-confidence multiplier to a shaky section', () => {
    const c = ctx({
      questions: [
        q({ id: 's1q1', sectionId: 's1', sectionOrdinal: 0, ordinal: 0, weight: 1 }),
        q({ id: 's1q2', sectionId: 's1', sectionOrdinal: 0, ordinal: 1, weight: 1 }),
        q({ id: 's2q1', sectionId: 's2', sectionOrdinal: 1, ordinal: 0, weight: 1 }),
      ],
      // s1's answer is low-confidence → s1q2 gets the 1.5× pull-back
      answered: [{ questionId: 's1q1', confidence: 0.3 }],
    });
    const byId = new Map(weightedScores(c).map((s) => [s.question.id, s.score]));
    // s1q2: 1 × (1 + 0.5×0.5) × 1.5 = 1.875 ; s2q1: 1 × (1 + 0.5×1) × 1 = 1.5
    expect(byId.get('s1q2')).toBeCloseTo(1.25 * LOW_CONFIDENCE_MULT);
    expect(byId.get('s1q2')!).toBeGreaterThan(byId.get('s2q1')!);
  });

  it('does not apply the low-confidence multiplier for unscored answers', () => {
    const c = ctx({
      questions: [
        q({ id: 'a', sectionId: 's1', ordinal: 0, weight: 1 }),
        q({ id: 'b', sectionId: 's1', ordinal: 1, weight: 1 }),
      ],
      answered: [{ questionId: 'a', confidence: null }],
    });
    const [top] = weightedScores(c);
    // inverseCompletion = 0.5, no low-conf → 1 × 1.25
    expect(top.score).toBeCloseTo(1.25);
  });

  it('breaks score ties by document order', () => {
    const c = ctx({
      questions: [
        q({ id: 'b', sectionOrdinal: 0, ordinal: 1, weight: 1 }),
        q({ id: 'a', sectionOrdinal: 0, ordinal: 0, weight: 1 }),
      ],
    });
    expect(weightedScores(c).map((s) => s.question.id)).toEqual(['a', 'b']);
  });

  it('scores only the required pool when required questions remain', () => {
    const c = ctx({
      questions: [
        q({ id: 'opt', ordinal: 0, required: false, weight: 99 }),
        q({ id: 'req', ordinal: 1, required: true, weight: 1 }),
      ],
    });
    const ranked = weightedScores(c).map((s) => s.question.id);
    expect(ranked).toEqual(['req']);
  });

  it('deduplicates duplicate answer rows so section completion never goes negative', () => {
    const c = ctx({
      questions: [
        q({ id: 's1q1', sectionId: 's1', ordinal: 0, weight: 1 }),
        q({ id: 's1q2', sectionId: 's1', ordinal: 1, weight: 1 }),
      ],
      // Two rows for the same answered question — without dedup, s1.answered would
      // be 2 of 2 → inverseCompletion 0 (or negative with 3 rows), zeroing the score.
      answered: [
        { questionId: 's1q1', confidence: null },
        { questionId: 's1q1', confidence: null },
      ],
    });
    const [top] = weightedScores(c);
    // Deduped: 1 of 2 answered → inverseCompletion 0.5 → 1 × (1 + 0.5×0.5) = 1.25.
    expect(top.question.id).toBe('s1q2');
    expect(top.score).toBeCloseTo(1.25);
  });
});

describe('weighted strategy — select', () => {
  it('asks the top-scoring question', async () => {
    const c = ctx({
      questions: [
        q({ id: 'light', ordinal: 0, weight: 1 }),
        q({ id: 'heavy', ordinal: 1, weight: 5 }),
      ],
    });
    const d = await select(c);
    expect(d).toMatchObject({ kind: 'ask', questionId: 'heavy', costUsd: 0 });
  });

  it('completes when nothing remains', async () => {
    const c = ctx({
      questions: [q({ id: 'a' })],
      answered: [{ questionId: 'a', confidence: null }],
    });
    expect((await select(c)).kind).toBe('complete');
  });
});
