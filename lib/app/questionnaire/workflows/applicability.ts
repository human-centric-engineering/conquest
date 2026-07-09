/**
 * Behind-the-Scenes questionnaire lens — server-only applicability.
 *
 * Builds the {@link ApplicabilityContext} for one questionnaire version by
 * combining the resolved feature flags, the version's saved config (or
 * defaults), its status + provenance, and three relation counts — then runs
 * every diagram's pure `applicability` predicate against it.
 *
 * Server-only: imports prisma + the flag resolvers. Never import from the
 * client canvas — the applicability map is fetched over the API.
 */

import { prisma } from '@/lib/db/client';
import {
  APP_QUESTIONNAIRE_STATUSES,
  type AppQuestionnaireStatus,
} from '@/lib/app/questionnaire/types';
import {
  isAdaptiveSelectionEnabled,
  isAdvisorEnabled,
  isAnswerExtractionEnabled,
  isDesignEvaluationEnabled,
  isGenerativeAuthoringEnabled,
  isTurnEvaluationEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { resolveQuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';
import { CONFIG_SELECT, toConfigView } from '@/app/api/v1/app/questionnaires/_lib/detail';

import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';
import type {
  ApplicabilityContext,
  WorkflowApplicability,
  WorkflowFlags,
} from '@/lib/app/questionnaire/workflows/types';

function coerceStatus(raw: string): AppQuestionnaireStatus {
  return (APP_QUESTIONNAIRE_STATUSES as readonly string[]).includes(raw)
    ? (raw as AppQuestionnaireStatus)
    : 'draft';
}

/** Resolve the normalised {@link WorkflowFlags} the predicates read. */
async function resolveWorkflowFlags(): Promise<WorkflowFlags> {
  const [
    ws,
    generativeAuthoring,
    answerExtraction,
    voiceInput,
    adaptiveSelection,
    turnEvaluation,
    designEvaluation,
    advisor,
  ] = await Promise.all([
    resolveQuestionnaireWorkspaceFlags(),
    isGenerativeAuthoringEnabled(),
    isAnswerExtractionEnabled(),
    isVoiceInputEnabled(),
    isAdaptiveSelectionEnabled(),
    isTurnEvaluationEnabled(),
    isDesignEvaluationEnabled(),
    isAdvisorEnabled(),
  ]);
  return {
    master: ws.master,
    generativeAuthoring,
    editAgent: ws.editAgent,
    liveSessions: ws.liveSessions,
    answerExtraction,
    dataSlots: ws.dataSlots,
    respondentReport: ws.respondentReport,
    cohortReport: ws.cohortReport,
    introScreen: ws.introScreen,
    voiceInput,
    personaSelection: ws.personaSelection,
    adaptiveSelection,
    turnEvaluation,
    designEvaluation,
    advisor,
  };
}

/**
 * Build the applicability context for a version, or `null` if the version does
 * not exist. Issues the flag resolution and the version/count queries in
 * parallel.
 */
export async function buildApplicabilityContext(
  versionId: string
): Promise<ApplicabilityContext | null> {
  const [flags, version] = await Promise.all([
    resolveWorkflowFlags(),
    prisma.appQuestionnaireVersion.findUnique({
      where: { id: versionId },
      select: {
        questionnaireId: true,
        status: true,
        goalProvenance: true,
        config: { select: CONFIG_SELECT },
        _count: { select: { sourceDocuments: true, dataSlots: true } },
      },
    }),
  ]);

  if (!version) return null;

  // A questionnaire is "in a round" at the questionnaire level (the round item
  // may pin a version or track the current launched one), so count by questionnaire.
  const roundItemCount = await prisma.appQuestionnaireRoundItem.count({
    where: { questionnaireId: version.questionnaireId },
  });

  return {
    flags,
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
