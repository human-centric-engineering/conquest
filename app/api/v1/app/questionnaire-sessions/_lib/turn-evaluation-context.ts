/**
 * Shared seam for the turn-evaluation routes — the evaluator agent binding and the
 * server-loaded questionnaire objectives that frame a verdict.
 *
 * Used by both `evaluate-turn` (live drawer dump) and `evaluate-saved` (persisted-trace
 * re-evaluation by `publicRef`) so the agent lookup and the objectives projection can't drift.
 * The per-turn conversation messages differ per route (a client body vs. a saved turn row), so
 * those stay at each call site; only the version-derived objectives live here.
 */

import { prisma } from '@/lib/db/client';
import { isRecord } from '@/lib/utils';
import type { TurnEvaluationContext } from '@/lib/app/questionnaire/turn-evaluation';

/** The seeded evaluator agent's slug — its provider/model binding drives the call. */
export const TURN_EVALUATOR_SLUG = 'turn-evaluator';

/** Pull the free-text persona out of the config's tone JSON, when present. */
export function summariseTone(tone: unknown): string | undefined {
  if (isRecord(tone) && typeof tone.persona === 'string' && tone.persona.trim()) {
    return tone.persona.trim();
  }
  return undefined;
}

/** Compact, bounded summary of the version's audience JSON for the prompt. */
export function summariseAudience(audience: unknown): string | undefined {
  if (audience === null || audience === undefined) return undefined;
  try {
    const s = typeof audience === 'string' ? audience : JSON.stringify(audience);
    if (!s || s === '{}' || s === 'null') return undefined;
    return s.slice(0, 2_000);
  } catch {
    return undefined;
  }
}

/** The version shape the objectives projection reads (goal/audience + a little config). */
export interface EvaluatorVersionObjectives {
  goal: string | null;
  audience: unknown;
  config: { selectionStrategy: string; tone: unknown } | null;
}

/**
 * Project the version's goal / audience / selection strategy / tone into the evaluator context
 * (absent fields simply omitted, so the evaluator degrades gracefully). The conversation messages
 * are layered on top by the caller.
 */
export function buildObjectivesContext(version: EvaluatorVersionObjectives): TurnEvaluationContext {
  const audience = summariseAudience(version.audience);
  const tone = summariseTone(version.config?.tone);
  return {
    ...(version.goal ? { goal: version.goal } : {}),
    ...(audience ? { audience } : {}),
    ...(version.config?.selectionStrategy
      ? { selectionStrategy: version.config.selectionStrategy }
      : {}),
    ...(tone ? { tone } : {}),
  };
}

/** The resolved evaluator agent binding the service needs. */
export interface TurnEvaluatorAgent {
  id: string;
  provider: string;
  model: string;
  fallbackProviders: string[];
}

/**
 * Load the seeded `turn-evaluator` judge agent's binding (empty provider/model → system default at
 * resolve time). Returns null when the agent isn't seeded — the caller maps that to a config 404.
 */
export async function loadTurnEvaluatorAgent(): Promise<TurnEvaluatorAgent | null> {
  return prisma.aiAgent.findFirst({
    where: { slug: TURN_EVALUATOR_SLUG, kind: 'judge' },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
}
