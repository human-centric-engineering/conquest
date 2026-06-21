import { describe, it, expect, vi } from 'vitest';
import {
  adaptiveStrategy,
  ADAPTIVE_CANDIDATE_K,
} from '@/lib/app/questionnaire/selection/strategies/adaptive';
import type { StrategyDeps } from '@/lib/app/questionnaire/selection/types';
import { ctx, q } from '@/tests/unit/lib/app/questionnaire/selection/_fixtures';

const select = adaptiveStrategy.select;

function deps(overrides: Partial<StrategyDeps> = {}): StrategyDeps {
  return {
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    rankByVector: vi.fn(async (_embedding, ids: string[], k: number) => ids.slice(0, k)),
    llmPick: vi.fn(async () => ({ questionId: 'b', rationale: 'flows naturally', costUsd: 0.004 })),
    ...overrides,
  };
}

const pool = () => [
  q({ id: 'a', ordinal: 0 }),
  q({ id: 'b', ordinal: 1 }),
  q({ id: 'c', ordinal: 2 }),
];

describe('adaptive strategy — fallbacks', () => {
  it('falls back to weighted when no deps are wired', async () => {
    const d = await select(ctx({ questions: pool(), recentMessages: ['hi'] }));
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' && d.rationale).toMatch(/fell back to weighted/i);
  });

  it('falls back to weighted when there is no conversation history', async () => {
    const dp = deps();
    const d = await select(ctx({ questions: pool() }), dp);
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' && d.rationale).toMatch(/no conversation history/i);
    expect(dp.embedText).not.toHaveBeenCalled();
  });

  it('falls back when vector search finds no embeddings', async () => {
    const dp = deps({ rankByVector: vi.fn(async () => []) });
    const d = await select(ctx({ questions: pool(), recentMessages: ['hi'] }), dp);
    expect(d.kind === 'ask' && d.rationale).toMatch(/no slot embeddings/i);
    expect(dp.llmPick).not.toHaveBeenCalled();
  });

  it('falls back when the LLM declines to choose', async () => {
    const dp = deps({
      llmPick: vi.fn(async () => ({ questionId: null, rationale: 'unsure', costUsd: 0.001 })),
    });
    const d = await select(ctx({ questions: pool(), recentMessages: ['hi'] }), dp);
    expect(d.kind === 'ask' && d.rationale).toMatch(/LLM declined/i);
  });

  it('falls back when the LLM returns an off-pool question id', async () => {
    const dp = deps({
      llmPick: vi.fn(async () => ({ questionId: 'not-in-pool', rationale: 'x', costUsd: 0.001 })),
    });
    const d = await select(ctx({ questions: pool(), recentMessages: ['hi'] }), dp);
    expect(d.kind === 'ask' && d.rationale).toMatch(/off-pool/i);
  });

  it('falls back (without throwing) when a dep errors', async () => {
    const dp = deps({
      embedText: vi.fn(async () => {
        throw new Error('embedding service down');
      }),
    });
    const d = await select(ctx({ questions: pool(), recentMessages: ['hi'] }), dp);
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' && d.rationale).toMatch(/error/i);
  });
});

describe('adaptive strategy — happy path', () => {
  it('asks the LLM-chosen question and propagates its cost', async () => {
    const dp = deps();
    const d = await select(ctx({ questions: pool(), recentMessages: ['I rent, not own'] }), dp);
    expect(d).toMatchObject({ kind: 'ask', questionId: 'b', costUsd: 0.004 });
    expect(d.kind === 'ask' && d.rationale).toBe('flows naturally');
    expect(dp.embedText).toHaveBeenCalledWith('I rent, not own');
    // The embedding from embedText flows straight into the vector search, over the
    // full candidate pool, capped at K — assert the arg shape, not just the count.
    expect(dp.rankByVector).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      ['a', 'b', 'c'],
      ADAPTIVE_CANDIDATE_K
    );
  });

  it('hands the LLM the goal, answered prompts, and per-candidate guidelines/rationale', async () => {
    const dp = deps();
    const c = ctx({
      goal: 'Understand onboarding friction',
      questions: [
        q({ id: 'a', ordinal: 0, prompt: 'How did you hear about us?' }),
        q({ id: 'b', ordinal: 1, prompt: 'What blocked you?', guidelines: 'A specific step' }),
        q({ id: 'c', ordinal: 2, prompt: 'How easy was it?', rationale: 'Sentiment baseline' }),
      ],
      answered: [{ questionId: 'a', confidence: null }],
      recentMessages: ['docs were confusing'],
    });
    await select(c, dp);

    expect(dp.llmPick).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'Understand onboarding friction',
        answeredQuestions: ['How did you hear about us?'],
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: 'b', guidelines: 'A specific step' }),
          expect.objectContaining({ id: 'c', rationale: 'Sentiment baseline' }),
        ]),
      })
    );
  });

  it('threads peer divergence (by key) onto the matching candidate for adaptive probing', async () => {
    const dp = deps();
    const c = ctx({
      questions: [
        q({ id: 'a', ordinal: 0 }),
        q({ id: 'b', ordinal: 1 }),
        q({ id: 'c', ordinal: 2 }),
      ],
      answered: [{ questionId: 'a', confidence: null }],
      recentMessages: ['hello'],
      // Keyed by question key (defaults to id in the fixture).
      peerDivergenceByKey: { b: 0.9 },
    });
    await select(c, dp);

    const candidates = (dp.llmPick as ReturnType<typeof vi.fn>).mock.calls[0][0].candidates;
    expect(candidates.find((x: { id: string }) => x.id === 'b').peerDivergence).toBe(0.9);
    // A candidate without a divergence entry carries none.
    expect(candidates.find((x: { id: string }) => x.id === 'c').peerDivergence).toBeUndefined();
  });

  it('asks the only remaining candidate directly without spending on the LLM', async () => {
    const dp = deps();
    const c = ctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [{ questionId: 'a', confidence: null }],
      recentMessages: ['hello'],
    });
    const d = await select(c, dp);
    expect(d).toMatchObject({ kind: 'ask', questionId: 'b', costUsd: 0 });
    expect(dp.llmPick).not.toHaveBeenCalled();
  });
});

describe('adaptive strategy — terminal', () => {
  it('completes when everything is answered, never touching deps', async () => {
    const dp = deps();
    const c = ctx({
      questions: [q({ id: 'a' })],
      answered: [{ questionId: 'a', confidence: null }],
      recentMessages: ['hi'],
    });
    expect((await select(c, dp)).kind).toBe('complete');
    expect(dp.embedText).not.toHaveBeenCalled();
  });
});
