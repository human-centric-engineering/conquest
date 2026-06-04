import { describe, it, expect } from 'vitest';
import {
  answeredCount,
  answeredQuestionIds,
  coverageRatio,
  requiredFirstPool,
  terminalDecision,
  unansweredQuestions,
} from '@/lib/app/questionnaire/selection/context';
import { ctx, q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

describe('unansweredQuestions', () => {
  it('excludes answered questions and sorts by (sectionOrdinal, ordinal)', () => {
    const c = ctx({
      questions: [
        q({ id: 'b', sectionOrdinal: 0, ordinal: 1 }),
        q({ id: 'a', sectionOrdinal: 0, ordinal: 0 }),
        q({ id: 'c', sectionOrdinal: 1, ordinal: 0 }),
      ],
      answered: [{ questionId: 'a', confidence: null }],
    });
    expect(unansweredQuestions(c).map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('breaks an ordinal tie deterministically by id', () => {
    const c = ctx({
      questions: [
        q({ id: 'y', sectionOrdinal: 0, ordinal: 0 }),
        q({ id: 'x', sectionOrdinal: 0, ordinal: 0 }),
      ],
    });
    expect(unansweredQuestions(c).map((x) => x.id)).toEqual(['x', 'y']);
  });
});

describe('answeredQuestionIds', () => {
  it('collects the answered ids into a set', () => {
    const c = ctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [{ questionId: 'a', confidence: 0.9 }],
    });
    expect([...answeredQuestionIds(c)]).toEqual(['a']);
  });
});

describe('requiredFirstPool', () => {
  it('returns only required questions when any are unanswered', () => {
    const pool = [q({ id: 'opt', required: false }), q({ id: 'req', required: true })];
    expect(requiredFirstPool(pool).map((x) => x.id)).toEqual(['req']);
  });

  it('returns the whole pool once no required questions remain', () => {
    const pool = [q({ id: 'o1', required: false }), q({ id: 'o2', required: false })];
    expect(requiredFirstPool(pool).map((x) => x.id)).toEqual(['o1', 'o2']);
  });
});

describe('coverageRatio', () => {
  it('is weighted, not a plain count', () => {
    const c = ctx({
      questions: [q({ id: 'a', weight: 3 }), q({ id: 'b', weight: 1 })],
      answered: [{ questionId: 'a', confidence: null }],
    });
    // 3 of 4 total weight covered.
    expect(coverageRatio(c)).toBeCloseTo(0.75);
  });

  it('returns 1 for a version with no questions (no divide-by-zero)', () => {
    expect(coverageRatio(ctx({ questions: [] }))).toBe(1);
  });

  it('falls back to a count ratio when questions exist but all weights are zero', () => {
    // No usable weights → coverage can't be weight-based; an unanswered version
    // must not read as fully covered.
    const unanswered = ctx({ questions: [q({ id: 'a', weight: 0 }), q({ id: 'b', weight: 0 })] });
    expect(coverageRatio(unanswered)).toBe(0);
    const half = ctx({
      questions: [q({ id: 'a', weight: 0 }), q({ id: 'b', weight: 0 })],
      answered: [{ questionId: 'a', confidence: null }],
    });
    expect(coverageRatio(half)).toBeCloseTo(0.5);
  });

  it('does not double-count a duplicate answer row', () => {
    const c = ctx({
      questions: [q({ id: 'a', weight: 1 }), q({ id: 'b', weight: 1 })],
      answered: [
        { questionId: 'a', confidence: 0.5 },
        { questionId: 'a', confidence: 0.9 },
      ],
    });
    expect(coverageRatio(c)).toBeCloseTo(0.5);
  });
});

describe('answeredCount', () => {
  it('counts distinct answered questions (deduplicates answer rows)', () => {
    const c = ctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [
        { questionId: 'a', confidence: 0.5 },
        { questionId: 'a', confidence: 0.9 },
      ],
    });
    // Two rows for the same question = one answered question.
    expect(answeredCount(c)).toBe(1);
  });
});

describe('terminalDecision', () => {
  it('returns null while questions remain and thresholds are unmet', () => {
    const c = ctx({ questions: [q({ id: 'a' }), q({ id: 'b' })] });
    expect(terminalDecision(c)).toBeNull();
  });

  it('completes a fully-answered fractional-weight version despite float drift', () => {
    // 0.1 weights sum with IEEE-754 rounding; coverage of a fully-answered set
    // can land at 0.9999999998, which must still satisfy a threshold of 1.
    const questions = Array.from({ length: 7 }, (_, i) => q({ id: `q${i}`, weight: 0.1 }));
    const c = ctx({
      questions,
      answered: questions.map((qq) => ({ questionId: qq.id, confidence: null })),
    });
    expect(terminalDecision(c)?.kind).toBe('complete');
  });

  it('does not double-count duplicate answers toward the per-session cap', () => {
    const c = ctx({
      questions: [q({ id: 'a' }), q({ id: 'b' }), q({ id: 'c' })],
      answered: [
        { questionId: 'a', confidence: null },
        { questionId: 'a', confidence: null },
      ],
      config: { maxQuestionsPerSession: 2 },
    });
    // Two rows for q 'a' = one answered question, so the cap of 2 is NOT hit yet.
    expect(terminalDecision(c)).toBeNull();
  });

  it('completes when the per-session cap is hit, even below coverage', () => {
    const c = ctx({
      questions: [q({ id: 'a' }), q({ id: 'b' }), q({ id: 'c' })],
      answered: [{ questionId: 'a', confidence: null }],
      config: { maxQuestionsPerSession: 1 },
    });
    const d = terminalDecision(c);
    expect(d?.kind).toBe('complete');
    expect(d && d.kind === 'complete' && d.rationale).toMatch(/cap of 1/);
  });

  it('completes when coverage meets the threshold and min answered is satisfied', () => {
    const c = ctx({
      questions: [q({ id: 'a', weight: 1 }), q({ id: 'b', weight: 1 })],
      answered: [{ questionId: 'a', confidence: null }],
      config: { coverageThreshold: 0.5, minQuestionsAnswered: 1 },
    });
    expect(terminalDecision(c)?.kind).toBe('complete');
  });

  it('does NOT complete when coverage is met but min-answered is not (a question still remains)', () => {
    const c = ctx({
      questions: [q({ id: 'a', weight: 1 }), q({ id: 'b', weight: 0 })],
      answered: [{ questionId: 'a', confidence: null }],
      // coverage = 1 (b has zero weight), but min requires 5 answered.
      config: { coverageThreshold: 1, minQuestionsAnswered: 5 },
    });
    // b is still unanswered, so this isn't terminal — null means "go pick b".
    expect(terminalDecision(c)).toBeNull();
  });

  it("returns 'none' when nothing remains but thresholds are unmet", () => {
    const c = ctx({
      questions: [q({ id: 'a' })],
      answered: [{ questionId: 'a', confidence: null }],
      config: { minQuestionsAnswered: 3 },
    });
    const d = terminalDecision(c);
    expect(d?.kind).toBe('none');
  });

  it('completes a fully-answered questionnaire under default config', () => {
    const c = ctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [
        { questionId: 'a', confidence: null },
        { questionId: 'b', confidence: null },
      ],
    });
    expect(terminalDecision(c)?.kind).toBe('complete');
  });
});
