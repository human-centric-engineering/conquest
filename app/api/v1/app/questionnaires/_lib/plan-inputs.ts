/**
 * Shared Scope-Planner inputs (P17) — the version-side half, loaded identically for every caller.
 *
 * Two callers plan a scope: the live trigger (`questionnaire-sessions/_lib/plan-scope.ts`, at the
 * end of a respondent's opening) and the authoring dry-run (`…/topics/preview`, from a synthetic
 * one). They differ legitimately in the SESSION-side half — one reads fills and answers off a real
 * session, the other takes them from a form — and they must not differ by a single value anywhere
 * else. **A preview that prices or projects the instrument differently from the interview is a
 * preview that lies**, and the way it would lie is quiet: a topic the author saw seated in the panel
 * and never sees seated in a real plan.
 *
 * So the version-side half lives here, in one place, rather than being assembled twice:
 *
 * - **Topics** come from `loadTopics` (`topic-routes.ts`) — already shared, already the projection
 *   the authoring routes use.
 * - **Pricing** is {@link loadPlanBudget}, moved here out of the live trigger so the dry-run cannot
 *   acquire a second copy of the arithmetic the fit stage works to.
 *
 * Route-local DB seam (uses `prisma`); the arithmetic itself stays pure in `scope/budget.ts`.
 */

import { prisma } from '@/lib/db/client';
import {
  estimateTopicCosts,
  itemSeconds,
  matrixRowCount,
} from '@/lib/app/questionnaire/scope/budget';
import type { PlanBudget } from '@/lib/app/questionnaire/scope/guardrails';
import type { AdaptiveScopeSettings, Topic } from '@/lib/app/questionnaire/scope/types';

/**
 * Price the version's topics for the fit stage (C7b), or null when there is no budget to fit to.
 *
 * Two queries, and only for a version whose author set a budget — the setting is `0` by default, so
 * the overwhelming majority of sessions never reach the `findMany`s at all.
 *
 * `weight` is loaded because a `light` topic asks its highest-weight members, so what a light topic
 * costs depends on it. Omitting it would price the blind-spot check off the wrong two questions —
 * which is the one cost the fit stage reserves before it judges anything to fit.
 */
export async function loadPlanBudget(
  versionId: string,
  settings: AdaptiveScopeSettings,
  topics: readonly Topic[]
): Promise<PlanBudget | null> {
  if (settings.sessionBudgetSeconds <= 0) return null;

  const [questions, dataSlots] = await Promise.all([
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      select: { key: true, type: true, typeConfig: true, weight: true },
    }),
    prisma.appDataSlot.findMany({ where: { versionId }, select: { key: true, weight: true } }),
  ]);

  const seconds = itemSeconds(
    questions.map((q) => ({ key: q.key, type: q.type, rowCount: matrixRowCount(q.typeConfig) })),
    dataSlots.map((d) => d.key),
    settings
  );

  return {
    budgetSeconds: settings.sessionBudgetSeconds,
    costs: estimateTopicCosts(topics, seconds, {
      byQuestionKey: new Map(questions.map((q) => [q.key, q.weight] as const)),
      byDataSlotKey: new Map(dataSlots.map((d) => [d.key, d.weight] as const)),
    }),
  };
}
