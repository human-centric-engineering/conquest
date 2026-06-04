import { describe, it, expect } from 'vitest';
import { randomStrategy } from '@/lib/app/questionnaire/selection/strategies/random';
import { ctx, q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

const select = randomStrategy.select;

const pool4 = () => [
  q({ id: 'a', ordinal: 0 }),
  q({ id: 'b', ordinal: 1 }),
  q({ id: 'c', ordinal: 2 }),
  q({ id: 'd', ordinal: 3 }),
];

describe('random strategy', () => {
  it('is idempotent for a fixed (sessionId, round)', async () => {
    const c = ctx({ questions: pool4(), sessionId: 'sess-x', round: 2 });
    const first = await select(c);
    for (let i = 0; i < 50; i++) {
      const again = await select(c);
      expect(again).toEqual(first);
    }
    expect(first.kind).toBe('ask');
  });

  it('only ever picks an unanswered question', async () => {
    const c = ctx({
      questions: pool4(),
      answered: [{ questionId: 'a', confidence: null }],
      sessionId: 'sess-y',
    });
    const ids = new Set<string>();
    for (let round = 0; round < 40; round++) {
      const d = await select({ ...c, round });
      if (d.kind === 'ask') ids.add(d.questionId);
    }
    expect(ids.has('a')).toBe(false);
  });

  it('exhausts required questions before optional ones', async () => {
    const c = ctx({
      questions: [
        q({ id: 'o1', ordinal: 0, required: false }),
        q({ id: 'o2', ordinal: 1, required: false }),
        q({ id: 'r1', ordinal: 2, required: true }),
        q({ id: 'r2', ordinal: 3, required: true }),
      ],
    });
    for (let round = 0; round < 40; round++) {
      const d = await select({ ...c, sessionId: `s${round}`, round });
      expect(d.kind).toBe('ask');
      expect(['r1', 'r2']).toContain(d.kind === 'ask' ? d.questionId : '');
    }
  });

  it('varies its pick across different sessions (not a constant)', async () => {
    const ids = new Set<string>();
    for (const sessionId of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const d = await select(ctx({ questions: pool4(), sessionId, round: 0 }));
      if (d.kind === 'ask') ids.add(d.questionId);
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  it('completes when nothing remains', async () => {
    const c = ctx({
      questions: [q({ id: 'a' })],
      answered: [{ questionId: 'a', confidence: null }],
    });
    expect((await select(c)).kind).toBe('complete');
  });
});
