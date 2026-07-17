/**
 * Behind-the-Scenes questionnaire lens — server-only applicability.
 *
 * Builds the {@link ApplicabilityContext} for one questionnaire version by
 * combining the version's saved config (or defaults), its status + provenance,
 * and three relation counts — then runs every diagram's pure `applicability`
 * predicate against it.
 *
 * Server-only: imports prisma. Never import from the client canvas — the
 * applicability map is fetched over the API.
 */

import { prisma } from '@/lib/db/client';
import {
  APP_QUESTIONNAIRE_STATUSES,
  type AppQuestionnaireStatus,
} from '@/lib/app/questionnaire/types';
import { CONFIG_SELECT, toConfigView } from '@/app/api/v1/app/questionnaires/_lib/detail';

import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';
import type {
  ApplicabilityContext,
  WorkflowApplicability,
} from '@/lib/app/questionnaire/workflows/types';

function coerceStatus(raw: string): AppQuestionnaireStatus {
  return (APP_QUESTIONNAIRE_STATUSES as readonly string[]).includes(raw)
    ? (raw as AppQuestionnaireStatus)
    : 'draft';
}

/**
 * Build the applicability context for a version, or `null` if the version does
 * not exist.
 */
export async function buildApplicabilityContext(
  versionId: string
): Promise<ApplicabilityContext | null> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      questionnaireId: true,
      status: true,
      goalProvenance: true,
      config: { select: CONFIG_SELECT },
      _count: { select: { sourceDocuments: true, dataSlots: true } },
    },
  });

  if (!version) return null;

  // A questionnaire is "in a round" at the questionnaire level (the round item
  // may pin a version or track the current launched one), so count by questionnaire.
  const roundItemCount = await prisma.appQuestionnaireRoundItem.count({
    where: { questionnaireId: version.questionnaireId },
  });

  return {
    config: toConfigView(version.config),
    versionStatus: coerceStatus(version.status),
    goalProvenance: version.goalProvenance ?? null,
    sourceDocumentCount: version._count.sourceDocuments,
    dataSlotCount: version._count.dataSlots,
    roundItemCount,
  };
}

/** Run every diagram's predicate against a context, keyed by workflow slug. */
export function evaluateApplicability(
  ctx: ApplicabilityContext
): Record<string, WorkflowApplicability> {
  const out: Record<string, WorkflowApplicability> = {};
  for (const diagram of WORKFLOW_DIAGRAMS) {
    out[diagram.slug] = diagram.applicability(ctx);
  }
  return out;
}
