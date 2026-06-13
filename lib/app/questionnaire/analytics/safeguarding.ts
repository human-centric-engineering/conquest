/**
 * Safeguarding summary (sensitivity awareness): how many sessions flagged a sensitive disclosure
 * over the window, and how many were serious. A lightweight admin signal — counts only, no
 * summaries, no session identities ever cross the boundary. k-anonymity suppressed below the
 * threshold (a count on a tiny cohort is itself re-identifying), using the same non-preview
 * session cohort the funnel uses.
 */

import { prisma } from '@/lib/db/client';
import { isCohortSuppressed } from '@/lib/app/questionnaire/analytics/privacy';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';
import type { SafeguardingSummary } from '@/lib/app/questionnaire/analytics/views';

/**
 * Count non-preview sessions in scope that flagged a sensitive disclosure (`sensitivityLevel` set)
 * and those that reached `high`. Suppressed (all zero) when the cohort is non-empty but below the
 * k-anonymity threshold.
 */
export async function getSafeguardingSummary(scope: AnalyticsScope): Promise<SafeguardingSummary> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  const sessions = await prisma.appQuestionnaireSession.findMany({
    where: {
      versionId: scope.versionId,
      isPreview: false,
      createdAt: { gte: scope.from, lt: scope.to },
    },
    select: { sensitivityLevel: true },
  });

  const flagged = sessions.filter((s) => s.sensitivityLevel !== null).length;
  const serious = sessions.filter((s) => s.sensitivityLevel === 'high').length;
  const suppressed = isCohortSuppressed(sessions.length);

  return {
    versionId: scope.versionId,
    range,
    flagged: suppressed ? 0 : flagged,
    serious: suppressed ? 0 : serious,
    suppressed,
  };
}
