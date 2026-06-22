/**
 * Cohorts & Rounds — batched session-completion stats.
 *
 * The route-local DB seam that turns a set of round ids into per-round started/completed
 * counts. Mirrors the enriched-list discipline of `questionnaires/_lib/list.ts`: a FIXED
 * number of queries regardless of how many rounds (one grouped sweep), folded into a Map —
 * never a per-row N+1. Shared by the rounds list AND the cohorts list (which sums its
 * cohorts' rounds). `isPreview: false` is applied exactly as every analytics reader does, so
 * admin rehearsal sessions never inflate completion. "Completed" is the literal
 * `status === 'completed'`.
 */

import { prisma } from '@/lib/db/client';
import type { RoundCompletionStats } from '@/lib/app/questionnaire/rounds/types';

export interface RoundSessionCounts {
  started: number;
  completed: number;
}

/** Per-round started/completed counts for the given round ids (one grouped query). */
export async function sessionCountsByRound(
  roundIds: readonly string[]
): Promise<Map<string, RoundSessionCounts>> {
  const result = new Map<string, RoundSessionCounts>();
  if (roundIds.length === 0) return result;

  const groups = await prisma.appQuestionnaireSession.groupBy({
    by: ['roundId', 'status'],
    where: { roundId: { in: [...roundIds] }, isPreview: false },
    _count: { _all: true },
  });

  for (const g of groups) {
    if (!g.roundId) continue;
    const entry = result.get(g.roundId) ?? { started: 0, completed: 0 };
    entry.started += g._count._all;
    if (g.status === 'completed') entry.completed += g._count._all;
    result.set(g.roundId, entry);
  }
  return result;
}

/**
 * Per-SUBGROUP started/completed counts within ONE round (one grouped query), keyed by the session's
 * `cohortSubgroupId` snapshot. Powers per-phase completion stats — an admin can see whether the
 * leadership phase finished before the next opens. Sessions with no subgroup (the round-window
 * remainder) carry a null snapshot and are skipped here; they're reflected in the round-level total.
 */
export async function sessionCountsBySubgroup(
  roundId: string
): Promise<Map<string, RoundSessionCounts>> {
  const result = new Map<string, RoundSessionCounts>();

  const groups = await prisma.appQuestionnaireSession.groupBy({
    by: ['cohortSubgroupId', 'status'],
    where: { roundId, isPreview: false },
    _count: { _all: true },
  });

  for (const g of groups) {
    if (!g.cohortSubgroupId) continue;
    const entry = result.get(g.cohortSubgroupId) ?? { started: 0, completed: 0 };
    entry.started += g._count._all;
    if (g.status === 'completed') entry.completed += g._count._all;
    result.set(g.cohortSubgroupId, entry);
  }
  return result;
}

/** Project raw counts to the client-facing completion view (rate rounded to 2 dp). */
export function toCompletionStats(counts: RoundSessionCounts | undefined): RoundCompletionStats {
  const started = counts?.started ?? 0;
  const completed = counts?.completed ?? 0;
  const completionRate = started === 0 ? 0 : Math.round((completed / started) * 100) / 100;
  return { sessionsStarted: started, sessionsCompleted: completed, completionRate };
}
