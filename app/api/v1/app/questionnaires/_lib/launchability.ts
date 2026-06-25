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
import {
  isAdaptiveDataSlotSelectionEnabled,
  isAdaptiveSelectionEnabled,
  isDataSlotsEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  launchReadinessChecks,
  type LaunchReadinessCheck,
} from '@/lib/app/questionnaire/launch/readiness';
import { hasCompleteLikertLabels } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { slotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { dataSlotEmbeddingCoverage } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';

export interface VersionLaunchReadiness {
  ready: boolean;
  checks: LaunchReadinessCheck[];
}

export interface LaunchReadinessOptions {
  /**
   * Include the adaptive "Questions embedded" check (default `true`). The launch gate keeps it on;
   * the **preview** gate passes `false`, so a draft can be rehearsed before its slots are embedded
   * — the live turn loop embeds them lazily as a backstop. See `slot-embeddings.ts`.
   */
  includeEmbeddings?: boolean;
}

/**
 * Resolve a version's launch readiness — the same criteria the launch gate enforces (goal,
 * audience, ≥1 section, ≥1 question, a saved config, generated data slots when that feature is on,
 * and — for an `adaptive` version with the sub-flag on — embedded question slots). `ready` is true
 * when every check passes.
 */
export async function loadLaunchReadiness(
  versionId: string,
  options: LaunchReadinessOptions = {}
): Promise<VersionLaunchReadiness> {
  const includeEmbeddings = options.includeEmbeddings ?? true;

  const [
    version,
    sectionCount,
    questionCount,
    likertSlots,
    config,
    dataSlotsEnabled,
    dataSlotCount,
    adaptiveEnabled,
    dataSlotAdaptiveEnabled,
  ] = await Promise.all([
    prisma.appQuestionnaireVersion.findUnique({
      where: { id: versionId },
      select: { goal: true, audience: true },
    }),
    prisma.appQuestionnaireSection.count({ where: { versionId } }),
    prisma.appQuestionSlot.count({ where: { versionId } }),
    // Likert configs, to enforce "every scale is labelled" before launch.
    prisma.appQuestionSlot.findMany({
      where: { versionId, type: 'likert' },
      select: { typeConfig: true },
    }),
    prisma.appQuestionnaireConfig.findUnique({
      where: { versionId },
      select: { selectionStrategy: true },
    }),
    isDataSlotsEnabled(),
    prisma.appDataSlot.count({ where: { versionId } }),
    isAdaptiveSelectionEnabled(),
    isAdaptiveDataSlotSelectionEnabled(),
  ]);

  // Question embeddings are a launch requirement only for an adaptive version while the sub-flag is
  // on — otherwise adaptive degrades to weighted at runtime and embeddings are irrelevant.
  const embeddingsRequired =
    includeEmbeddings && adaptiveEnabled && config?.selectionStrategy === 'adaptive';
  // Data-slot embeddings are required only when adaptive data-slot selection is on AND the version
  // actually has data slots (else the deterministic topic-local pick runs and embeddings are moot).
  const dataSlotEmbeddingsRequired =
    includeEmbeddings && dataSlotAdaptiveEnabled && dataSlotCount >= 1;

  const [coverage, dataSlotCoverage] = await Promise.all([
    embeddingsRequired ? slotEmbeddingCoverage(versionId) : Promise.resolve(null),
    dataSlotEmbeddingsRequired ? dataSlotEmbeddingCoverage(versionId) : Promise.resolve(null),
  ]);

  const unlabelledLikertCount = likertSlots.filter(
    (s) => !hasCompleteLikertLabels(s.typeConfig)
  ).length;

  const checks = launchReadinessChecks({
    goal: version?.goal ?? null,
    audience: version?.audience ?? null,
    sectionCount,
    questionCount,
    likertCount: likertSlots.length,
    unlabelledLikertCount,
    configSaved: config !== null,
    dataSlotsRequired: dataSlotsEnabled,
    dataSlotsReady: dataSlotCount >= 1,
    embeddingsRequired,
    embeddingsReady: coverage !== null && coverage.total > 0 && coverage.missing === 0,
    dataSlotEmbeddingsRequired,
    dataSlotEmbeddingsReady:
      dataSlotCoverage !== null && dataSlotCoverage.total > 0 && dataSlotCoverage.missing === 0,
  });

  return { ready: checks.every((c) => c.ok), checks };
}
