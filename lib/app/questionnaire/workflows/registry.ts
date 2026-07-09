/**
 * Behind-the-Scenes workflow registry — the ordered list of hand-authored
 * ConQuest pipeline diagrams, plus lookup helpers.
 *
 * Pure (no server/prisma/React imports): safe to import from both the API
 * route and, if ever needed, the client. New diagrams are added by dropping a
 * `definitions/<slug>.ts` file and appending it to `WORKFLOW_DIAGRAMS` below.
 */

import type {
  ConquestWorkflowDiagram,
  WorkflowSummary,
} from '@/lib/app/questionnaire/workflows/types';

import { answerExtractionWorkflow } from '@/lib/app/questionnaire/workflows/definitions/answer-extraction';
import { cohortReportWorkflow } from '@/lib/app/questionnaire/workflows/definitions/cohort-report';
import { configAdvisorWorkflow } from '@/lib/app/questionnaire/workflows/definitions/config-advisor';
import { conversationTurnWorkflow } from '@/lib/app/questionnaire/workflows/definitions/conversation-turn';
import { designEvaluationWorkflow } from '@/lib/app/questionnaire/workflows/definitions/design-evaluation';
import { dataSlotGenerationWorkflow } from '@/lib/app/questionnaire/workflows/definitions/data-slot-generation';
import { dataSlotTurnWorkflow } from '@/lib/app/questionnaire/workflows/definitions/data-slot-turn';
import { generativeAuthoringWorkflow } from '@/lib/app/questionnaire/workflows/definitions/generative-authoring';
import { ingestionWorkflow } from '@/lib/app/questionnaire/workflows/definitions/ingestion';
import { respondentReportWorkflow } from '@/lib/app/questionnaire/workflows/definitions/respondent-report';
import { structureEditWorkflow } from '@/lib/app/questionnaire/workflows/definitions/structure-edit';
import { turnEvaluationWorkflow } from '@/lib/app/questionnaire/workflows/definitions/turn-evaluation';
import { turnInspectorWorkflow } from '@/lib/app/questionnaire/workflows/definitions/turn-inspector';

/** All diagrams, in demo/presentation order. */
export const WORKFLOW_DIAGRAMS: readonly ConquestWorkflowDiagram[] = [
  ingestionWorkflow,
  generativeAuthoringWorkflow,
  structureEditWorkflow,
  dataSlotGenerationWorkflow,
  conversationTurnWorkflow,
  answerExtractionWorkflow,
  dataSlotTurnWorkflow,
  respondentReportWorkflow,
  cohortReportWorkflow,
  designEvaluationWorkflow,
  configAdvisorWorkflow,
  turnInspectorWorkflow,
  turnEvaluationWorkflow,
] as const;

/** Look up one diagram by slug. */
export function getWorkflowDiagram(slug: string): ConquestWorkflowDiagram | undefined {
  return WORKFLOW_DIAGRAMS.find((d) => d.slug === slug);
}

/** Card-shaped summaries for the workflow picker (no applicability). */
export function listWorkflowSummaries(): WorkflowSummary[] {
  return WORKFLOW_DIAGRAMS.map((d) => ({
    slug: d.slug,
    title: d.title,
    description: d.description,
    sourceModule: d.sourceModule,
    stepCount: d.definition.steps.length,
  }));
}
