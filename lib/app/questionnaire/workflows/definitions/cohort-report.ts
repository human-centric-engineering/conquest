/**
 * Workflow diagram: Cohort report.
 *
 * The cross-respondent synthesis pipeline
 * (`lib/app/questionnaire/cohort-report/generate.ts`). Build a k-anonymised
 * dataset and data-slot theme material, optionally pull round/cohort context,
 * then a model writes sections and proposes charts that are rendered before the
 * report is published. Only meaningful once a version is part of a round.
 */

import { COHORT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const cohortReportWorkflow = diagram({
  slug: 'cohort-report',
  title: 'Cohort report',
  description:
    "Across a whole round of respondents, the cohort report finds the pattern. It builds a k-anonymised dataset and the data-slot theme material, optionally pulls the round's context, then a model writes the synthesis and proposes charts — distributions and segment means — that get rendered into the published report.",
  sourceModule: 'lib/app/questionnaire/cohort-report/generate.ts',
  entryStepId: 'dataset',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'dataset',
      name: 'Build dataset',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Build the cross-respondent dataset and a digest, applying k-anonymity suppression so no small group can be re-identified.',
      meta: { note: 'Build the cross-respondent dataset + digest; k-anonymity suppression.' },
      next: ['material'],
    }),
    node({
      id: 'material',
      name: 'Theme material',
      type: 'tool_call',
      x: 220,
      y: 0,
      description:
        'Assemble the data-slot theme material — where each respondent sits on the themes the questionnaire captured — as the raw material for synthesis.',
      meta: { note: 'Data-slot theme material — respondent positions.' },
      next: ['context'],
    }),
    node({
      id: 'context',
      name: 'Retrieve context',
      type: 'rag_retrieve',
      x: 440,
      y: 0,
      description:
        'Optionally pull round, cohort, or knowledge-base context so the synthesis is grounded in the surrounding programme, not just the raw answers.',
      meta: {
        kb: {
          status: 'active',
          mechanism: 'demo-client-tag',
          description:
            'Round-scoped cohort reports can pull the cohort/round knowledge context to ground the synthesis.',
        },
        note: 'Optional round/cohort/KB context.',
        settings: [
          {
            key: 'cohortReport.generation.useClientKnowledge',
            label: 'Client knowledge grounding',
            effect: "When on, cohort synthesis can pull the client's knowledge context.",
          },
        ],
      },
      next: ['synthesize'],
    }),
    node({
      id: 'synthesize',
      name: 'Synthesize report',
      type: 'agent_call',
      x: 660,
      y: 0,
      description:
        'The model writes the report sections and proposes the charts that best tell the story of the cohort.',
      meta: {
        agentSlug: COHORT_REPORT_AGENT_SLUG,
        note: 'The model writes sections + proposes charts.',
        settings: [
          {
            key: 'cohortReport.enabled',
            label: 'Cohort report',
            effect: 'Master toggle for cohort report generation for this questionnaire.',
          },
        ],
      },
      next: ['charts'],
    }),
    node({
      id: 'charts',
      name: 'Render charts',
      type: 'tool_call',
      x: 880,
      y: 0,
      description:
        'Render the proposed charts — distributions and segment means — deterministically from the dataset so the visuals are exact, not model-drawn.',
      meta: {
        note: 'Render proposed charts (distributions, segment means).',
        settings: [
          {
            key: 'cohortReport.generation.scoringEnabled',
            label: 'Deterministic scoring',
            effect: 'When on, scored metrics feed the proposed charts alongside the AI synthesis.',
          },
        ],
      },
      next: ['publish'],
    }),
    node({
      id: 'publish',
      name: 'Publish report',
      type: 'report',
      x: 1100,
      y: 0,
      description: 'Persist and publish the finished cohort report with its rendered charts.',
      meta: { note: 'Persist and publish the finished cohort report.' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.cohortReport) {
      return unavailable('Cohort reporting is not enabled.');
    }
    if (!ctx.config.cohortReport.enabled) {
      return inactive('Cohort reporting is turned off for this questionnaire.');
    }
    if (ctx.roundItemCount === 0) {
      return inactive('This questionnaire is not part of a cohort round yet.');
    }
    return applies('This questionnaire is part of a round — a cohort report can be synthesised.');
  },
});
