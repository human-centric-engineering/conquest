/**
 * Strategy: adaptive.
 *
 * Picks the question that flows most naturally from what the respondent just
 * said. It embeds their latest message, narrows the unanswered pool to the most
 * semantically similar candidates (pgvector), then asks an LLM which of those to
 * raise next. The impure work — embedding, vector search, the LLM call — arrives
 * through injected {@link StrategyDeps}, so this file stays Prisma-free and
 * unit-testable with mocks; the real deps are wired at the route/engine seam.
 *
 * **Fail soft, always.** Adaptive is the only strategy that can fail (no deps,
 * no message history, no slot embeddings, an LLM/budget error, an off-pool pick).
 * Every one of those degrades to the deterministic `weighted` pick rather than
 * throwing — a respondent never sees a turn break because the LLM was down. The
 * `adaptive`-vs-`weighted` config feature gate is enforced upstream (the route
 * simply withholds deps when adaptive is disabled, which lands here as the
 * no-deps fallback).
 */

import { registerStrategy } from '@/lib/app/questionnaire/selection/registry';
import { logger } from '@/lib/logging';
import {
  requiredFirstPool,
  terminalDecision,
  unansweredQuestions,
} from '@/lib/app/questionnaire/selection/context';
import { weightedScores } from '@/lib/app/questionnaire/selection/strategies/weighted';
import type {
  QuestionView,
  SelectionContext,
  SelectionDecision,
  SelectionStrategyPlugin,
  StrategyDeps,
} from '@/lib/app/questionnaire/selection/types';

/** How many similarity-ranked candidates to hand the LLM. */
export const ADAPTIVE_CANDIDATE_K = 5;

/**
 * Build a `weighted` pick for the same context, tagging the rationale with why
 * adaptive deferred. `terminalDecision` has already been checked by the caller,
 * so the pool is guaranteed non-empty here.
 */
function weightedFallback(ctx: SelectionContext, reason: string): SelectionDecision {
  const top = weightedScores(ctx)[0];
  return {
    kind: 'ask',
    questionId: top.question.id,
    rationale: `Adaptive fell back to weighted (${reason}): chose ${top.question.key}.`,
    costUsd: 0,
  };
}

async function select(ctx: SelectionContext, deps?: StrategyDeps): Promise<SelectionDecision> {
  const terminal = terminalDecision(ctx);
  if (terminal) return terminal;

  const pool = requiredFirstPool(unansweredQuestions(ctx));

  // No deps (adaptive disabled / not wired) or no conversation yet → weighted.
  const lastMessage = ctx.recentMessages?.[ctx.recentMessages.length - 1]?.trim();
  if (!deps) return weightedFallback(ctx, 'no strategy deps wired');
  if (!lastMessage) return weightedFallback(ctx, 'no conversation history yet');

  // One candidate left — the LLM has no real choice to make, so skip the spend.
  if (pool.length === 1) {
    return {
      kind: 'ask',
      questionId: pool[0].id,
      rationale: `Only one question remains (${pool[0].key}); asked it directly.`,
      costUsd: 0,
    };
  }

  const byId = new Map<string, QuestionView>(pool.map((q) => [q.id, q]));

  try {
    const embedding = await deps.embedText(lastMessage);
    const rankedIds = await deps.rankByVector(
      embedding,
      pool.map((q) => q.id),
      ADAPTIVE_CANDIDATE_K
    );
    if (rankedIds.length === 0) {
      // Adaptive is enabled and there's conversation history, but no candidate
      // has an embedding — almost always "the version was never embedded". Warn
      // (not silent) so an operator can spot the misconfiguration and run the
      // embed-questions backfill, rather than silently getting weighted forever.
      logger.warn('Adaptive selection found no slot embeddings; run embed-questions backfill', {
        sessionId: ctx.sessionId,
        candidateCount: pool.length,
      });
      return weightedFallback(ctx, 'no slot embeddings to rank against');
    }

    const candidates = rankedIds
      .map((id) => byId.get(id))
      .filter((q): q is QuestionView => q !== undefined)
      .map((q) => {
        // Learning Mode (adaptive probing): attach this topic's peer divergence (by key) so the
        // selector can lean toward probing where earlier respondents split. Absent when not learning.
        const peerDivergence = ctx.peerDivergenceByKey?.[q.key];
        return {
          id: q.id,
          key: q.key,
          prompt: q.prompt,
          guidelines: q.guidelines,
          rationale: q.rationale,
          ...(typeof peerDivergence === 'number' ? { peerDivergence } : {}),
        };
      });

    // Prompts of questions already answered (deterministic order) — so the selector
    // sees what's covered and doesn't pick a question that re-treads it.
    const answeredIds = new Set(ctx.answered.map((a) => a.questionId));
    const answeredQuestions = ctx.questions
      .filter((q) => answeredIds.has(q.id))
      .slice()
      .sort((a, b) => a.sectionOrdinal - b.sectionOrdinal || a.ordinal - b.ordinal)
      .map((q) => q.prompt)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    const pick = await deps.llmPick({
      recentMessages: ctx.recentMessages ?? [],
      candidates,
      sessionId: ctx.sessionId,
      ...(ctx.goal ? { goal: ctx.goal } : {}),
      ...(answeredQuestions.length > 0 ? { answeredQuestions } : {}),
    });

    // Null pick, or a pick that isn't a live candidate, → weighted (don't trust
    // an off-pool id from the model).
    if (pick.questionId === null || !byId.has(pick.questionId)) {
      return weightedFallback(
        ctx,
        pick.questionId === null ? 'LLM declined to choose' : 'LLM returned an off-pool pick'
      );
    }

    return {
      kind: 'ask',
      questionId: pick.questionId,
      rationale: pick.rationale,
      costUsd: pick.costUsd,
    };
  } catch (err) {
    logger.warn('Adaptive selection failed; falling back to weighted', {
      sessionId: ctx.sessionId,
      round: ctx.round,
      error: err instanceof Error ? err.message : String(err),
    });
    return weightedFallback(ctx, 'LLM or vector-search error');
  }
}

export const adaptiveStrategy: SelectionStrategyPlugin = {
  slug: 'adaptive',
  description:
    'Embeds the latest message, finds the most similar unanswered questions, and asks an LLM which flows best. Falls back to weighted on any failure.',
  select,
};

registerStrategy(adaptiveStrategy);
