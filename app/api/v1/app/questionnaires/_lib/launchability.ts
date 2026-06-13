/**
 * Server launch-readiness seam.
 *
 * Loads a version's readiness facts from the DB and runs them through the pure
 * {@link launchReadinessChecks}. One server source for the launch gate (status route) AND the
 * "Preview as respondent" gate (a launchable draft is previewable before launch) — so the two
 * apply identical criteria. The `lib/app/questionnaire/launch` module stays Prisma-free; this is
 * its DB seam.
 */

import { prisma } from '@/lib/db/client';
import { isDataSlotsEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  launchReadinessChecks,
  type LaunchReadinessCheck,
} from '@/lib/app/questionnaire/launch/readiness';

export interface VersionLaunchReadiness {
  ready: boolean;
  checks: LaunchReadinessCheck[];
}

/**
 * Resolve a version's launch readiness — the same criteria the launch gate enforces (goal,
 * audience, ≥1 section, ≥1 question, a saved config, and — when the data-slots feature is on —
 * generated data slots). `ready` is true when every check passes.
 */
export async function loadLaunchReadiness(versionId: string): Promise<VersionLaunchReadiness> {
  const [version, sectionCount, questionCount, configCount, dataSlotsRequired, dataSlotCount] =
    await Promise.all([
      prisma.appQuestionnaireVersion.findUnique({
        where: { id: versionId },
        select: { goal: true, audience: true },
      }),
      prisma.appQuestionnaireSection.count({ where: { versionId } }),
      prisma.appQuestionSlot.count({ where: { versionId } }),
      prisma.appQuestionnaireConfig.count({ where: { versionId } }),
      isDataSlotsEnabled(),
      prisma.appDataSlot.count({ where: { versionId } }),
    ]);

  const checks = launchReadinessChecks({
    goal: version?.goal ?? null,
    audience: version?.audience ?? null,
    sectionCount,
    questionCount,
    configSaved: configCount >= 1,
    dataSlotsRequired,
    dataSlotsReady: dataSlotCount >= 1,
  });

  return { ready: checks.every((c) => c.ok), checks };
}
