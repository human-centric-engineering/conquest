/**
 * Strategy: random.
 *
 * Picks uniformly at random among the unanswered questions — required ones first
 * (so mandatory questions are exhausted before optional), then optional. Used to
 * vary question order across respondents and defeat position bias.
 *
 * **Seeded, not truly random.** The pick is a pure function of
 * `sessionId + round`, so a crashed/retried turn re-selects the *same* question
 * instead of jumping elsewhere. That idempotency is why this avoids `Math.random`
 * — replay safety matters more than cryptographic randomness here.
 */

import { registerStrategy } from '@/lib/app/questionnaire/selection/registry';
import {
  requiredFirstPool,
  terminalDecision,
  unansweredQuestions,
} from '@/lib/app/questionnaire/selection/context';
import type {
  SelectionContext,
  SelectionDecision,
  SelectionStrategyPlugin,
} from '@/lib/app/questionnaire/selection/types';

/**
 * Deterministic 32-bit string hash (FNV-1a). Same string → same non-negative
 * integer, on every engine, forever — which is all the seeding needs.
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in unsigned range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the plugin contract; body is sync.
async function select(ctx: SelectionContext): Promise<SelectionDecision> {
  const terminal = terminalDecision(ctx);
  if (terminal) return terminal;

  // Required-first, over a deterministically-ordered remaining pool, so the seed
  // indexes a stable list.
  const pool = requiredFirstPool(unansweredQuestions(ctx));
  const index = fnv1a(`${ctx.sessionId}:${ctx.round}`) % pool.length;
  const next = pool[index];

  return {
    kind: 'ask' as const,
    questionId: next.id,
    rationale: `Randomly chose ${next.key} (${next.required ? 'required' : 'optional'}) from ${pool.length} candidate${pool.length === 1 ? '' : 's'}, seeded on session+round.`,
    costUsd: 0,
  };
}

export const randomStrategy: SelectionStrategyPlugin = {
  slug: 'random',
  description:
    'Picks uniformly at random among remaining questions (required first), seeded on session + round for replay safety.',
  select,
};

registerStrategy(randomStrategy);
