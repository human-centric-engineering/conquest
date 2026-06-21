/**
 * Round item → effective version resolution.
 *
 * A round item either pins an exact `versionId` or follows the questionnaire's current launched
 * version (highest `versionNumber` with `status = launched`). Several round `_lib` readers need this
 * mapping (invitations, briefing/learning version resolution), so it lives here once rather than
 * being copied per consumer. One launched-version sweep over all unpinned items — no per-item query.
 */

import { prisma } from '@/lib/db/client';

/**
 * Resolve each round item to its effective version — the pinned `versionId`, else the
 * questionnaire's current launched version, else `null` when neither exists. Keyed by
 * `questionnaireId`. A FIXED query budget (one launched sweep for all unpinned items).
 */
export async function resolveItemVersions(
  items: { questionnaireId: string; versionId: string | null }[]
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  const unpinnedQids = items.filter((i) => !i.versionId).map((i) => i.questionnaireId);
  let launchedByQuestionnaire = new Map<string, string>();
  if (unpinnedQids.length > 0) {
    // Highest versionNumber first → the first row seen per questionnaire is its current launched one.
    const launched = await prisma.appQuestionnaireVersion.findMany({
      where: { questionnaireId: { in: unpinnedQids }, status: 'launched' },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, questionnaireId: true },
    });
    launchedByQuestionnaire = launched.reduce((map, v) => {
      if (!map.has(v.questionnaireId)) map.set(v.questionnaireId, v.id);
      return map;
    }, new Map<string, string>());
  }
  for (const item of items) {
    resolved.set(
      item.questionnaireId,
      item.versionId ?? launchedByQuestionnaire.get(item.questionnaireId) ?? null
    );
  }
  return resolved;
}
