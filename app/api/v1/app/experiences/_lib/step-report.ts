/**
 * Experience-step report route helpers (report kind `cohort`, experience_step scope — F15.4).
 *
 * A step report reuses the ENTIRE cohort-report pipeline (dataset → agent → revisions → publish →
 * PDF) unchanged, scoped to the legs of one step of one experience. That is the whole point of
 * scoping per step rather than per experience: a step pins exactly one questionnaire version, so
 * `buildCohortDataset` and `chart-series.ts` keep their single-data-slot-vocabulary assumption and
 * need zero changes.
 *
 * These helpers resolve the {@link ReportScope} for an `(experienceId, stepId)` pair and apply the
 * same per-version opt-in gate the round and version routes use, so the step routes stay thin.
 * Server-side.
 */

import { prisma } from '@/lib/db/client';
import {
  experienceStepScope,
  narrowCohortReportSettings,
} from '@/lib/app/questionnaire/cohort-report';
import type { ReportScope } from '@/lib/app/questionnaire/cohort-report';
import { resolveStepVersionId } from '@/app/api/v1/app/experiences/_lib/steps';

/** Resolved step-report scope + display metadata, or null when the pair doesn't resolve. */
export interface StepReportScope {
  scope: ReportScope;
  /** Display name for audit + the report title. */
  entityName: string;
  /** The version the step's legs actually ran — the analysed subject. */
  versionId: string;
}

/**
 * Resolve the experience-step {@link ReportScope} for a scoped `(experienceId, stepId)`.
 *
 * Returns null when the step does not belong to that experience (→ route 404), when it has no
 * questionnaire attached, or when its version pointer cannot be resolved. All three are ordinary
 * states rather than errors: a step is authored incrementally and its target pointers are
 * unmodelled (UG-1), so they may legitimately be absent or dangling.
 *
 * The version is resolved the same way a RUN resolves it — a pinned `versionId`, else the newest
 * launched version. A report must analyse the version the legs actually ran.
 */
export async function loadStepReportScope(
  experienceId: string,
  stepId: string
): Promise<StepReportScope | null> {
  const step = await prisma.appExperienceStep.findFirst({
    // Scoped by BOTH ids: a step id from another experience must 404, not silently report.
    where: { id: stepId, experienceId },
    select: { id: true, title: true, questionnaireId: true, versionId: true },
  });
  if (!step || !step.questionnaireId) return null;

  const versionId = await resolveStepVersionId(step);
  if (!versionId) return null;

  const experience = await prisma.appExperience.findUnique({
    where: { id: experienceId },
    select: { title: true },
  });
  const experienceTitle = experience?.title ?? 'Experience';
  const label = `${experienceTitle} — ${step.title}`;

  return {
    scope: experienceStepScope(step.id, versionId, label),
    entityName: label,
    versionId,
  };
}

/**
 * Whether the cohort report is enabled for the version this step runs.
 *
 * Reuses the per-version `config.cohortReport.enabled` opt-in the round and version-wide reports
 * AND — same feature, same switch. Deliberately NOT a new experience-level setting: an author who
 * turned reporting off for a questionnaire has not consented to it being generated because that
 * questionnaire was reached through a journey.
 */
export async function isStepReportEnabledForVersion(versionId: string): Promise<boolean> {
  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { cohortReport: true },
  });
  return narrowCohortReportSettings(config?.cohortReport).enabled;
}
