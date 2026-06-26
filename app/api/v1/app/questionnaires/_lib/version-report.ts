/**
 * Version-wide report route helpers (report kind `cohort`, version scope).
 *
 * The version-wide report reuses the entire cohort-report pipeline (dataset → agent → revisions →
 * publish → PDF) but scopes to ALL of a version's completed sessions — every round AND open-ended
 * (non-round) sessions — rather than one round. These helpers resolve the {@link ReportScope} for a
 * `(questionnaireId, versionId)` pair (404-safe via `loadScopedVersion`) and apply the same
 * per-version opt-in gate the round routes use, so the version routes stay thin. Server-side.
 */

import { prisma } from '@/lib/db/client';
import { versionScope, narrowCohortReportSettings } from '@/lib/app/questionnaire/cohort-report';
import type { ReportScope } from '@/lib/app/questionnaire/cohort-report';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

/** Resolved version-report scope + display metadata, or null when the version doesn't resolve. */
export interface VersionReportScope {
  scope: ReportScope;
  /** Display name for audit + the report title (the questionnaire title). */
  entityName: string;
}

/**
 * Resolve the version-wide {@link ReportScope} for a scoped `(questionnaireId, versionId)`. Returns
 * null when the pair doesn't resolve (→ route 404), mirroring the round routes' `findUnique` 404.
 */
export async function loadVersionReportScope(
  questionnaireId: string,
  versionId: string
): Promise<VersionReportScope | null> {
  const version = await loadScopedVersion(questionnaireId, versionId);
  if (!version) return null;
  const questionnaire = await prisma.appQuestionnaire.findUnique({
    where: { id: questionnaireId },
    select: { title: true },
  });
  const title = questionnaire?.title ?? 'Questionnaire';
  return {
    scope: versionScope(versionId, `${title} — all rounds + open-ended sessions`),
    entityName: title,
  };
}

/**
 * Whether the version-wide report is enabled for this version. Reuses the per-version
 * `config.cohortReport.enabled` opt-in the round cohort report ANDs (same feature, same switch).
 */
export async function isVersionReportEnabledForVersion(versionId: string): Promise<boolean> {
  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { cohortReport: true },
  });
  return narrowCohortReportSettings(config?.cohortReport).enabled;
}
