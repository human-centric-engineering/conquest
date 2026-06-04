import { describe, it, expect } from 'vitest';
import { sequentialStrategy } from '@/lib/app/questionnaire/selection/strategies/sequential';
import { ctx, q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

const select = sequentialStrategy.select;

describe('sequential strategy', () => {
  it('asks the first question in document order', async () => {
    const c = ctx({
      questions: [
        q({ id: 'c', sectionOrdinal: 1, ordinal: 0 }),
        q({ id: 'a', sectionOrdinal: 0, ordinal: 0 }),
        q({ id: 'b', sectionOrdinal: 0, ordinal: 1 }),
      ],
    });
    const d = await select(c);
    expect(d).toMatchObject({ kind: 'ask', questionId: 'a', costUsd: 0 });
  });

  it('skips answered questions and asks the next in order', async () => {
    const c = ctx({
      questions: [
        q({ id: 'a', sectionOrdinal: 0, ordinal: 0 }),
        q({ id: 'b', sectionOrdinal: 0, ordinal: 1 }),
      ],
      answered: [{ questionId: 'a', confidence: null }],
    });
    const d = await select(c);
    expect(d.kind === 'ask' && d.questionId).toBe('b');
  });

  it('ignores required/optional — strict order only', async () => {
    const c = ctx({
      questions: [
        q({ id: 'opt', ordinal: 0, required: false }),
        q({ id: 'req', ordinal: 1, required: true }),
      ],
    });
    const d = await select(c);
    expect(d.kind === 'ask' && d.questionId).toBe('opt');
  });

  it('completes when every question is answered', async () => {
    const c = ctx({
      questions: [q({ id: 'a' })],
      answered: [{ questionId: 'a', confidence: null }],
    });
    expect((await select(c)).kind).toBe('complete');
  });

  it('completes an empty questionnaire (coverage trivially met)', async () => {
    expect((await select(ctx({ questions: [] }))).kind).toBe('complete');
  });
});
