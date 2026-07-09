/**
 * Workflow diagram: Respondent report.
 *
 * The per-respondent AI report pipeline
 * (`lib/app/questionnaire/report/generate.ts`). Load the captured answers, build
 * the transcript, optionally ground in a demo client's knowledge base, then a
 * reasoning model writes the report and an optional formatter polishes it.
 * Shown only when the questionnaire is in an AI report mode.
 */

import {
  REPORT_FORMATTER_AGENT_SLUG,
  RESPONDENT_REPORT_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const respondentReportWorkflow = diagram({
  slug: 'respondent-report',
  title: 'Respondent report',
  description: 'Writes one respondent a tailored narrative report.',
  sourceModule: 'lib/app/questionnaire/report/generate.ts',
  entryStepId: 'load',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'load',
      name: 'Load answers',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Load the captured answers for the session along with the client attribution that scopes any knowledge grounding.',
      meta: { note: 'Captured answers + client attribution.' },
      next: ['transcript'],
    }),
    node({
      id: 'transcript',
      name: 'Build transcript',
      type: 'tool_call',
      x: 220,
      y: 0,
      description:
        'Assemble the ordered question-and-answer transcript and a completion percentage — the factual base the report is written from.',
      meta: { note: 'Build the Q&A transcript + completion %.' },
      next: ['knowledge'],
    }),
    node({
      id: 'knowledge',
      name: 'Retrieve knowledge',
      type: 'rag_retrieve',
      x: 440,
      y: 0,
      description:
        'When the questionnaire is attributed to a demo client with a knowledge tag, retrieve the most relevant client documents to ground the report in real context.',
      meta: {
        kb: {
          status: 'active',
          mechanism: 'demo-client-tag',
          description:
            "When the questionnaire is attributed to a demo client with a knowledge tag, the report is grounded in that client's documents (top-6, best-effort).",
        },
        note: 'Optional client-KB grounding, scoped to the demo client.',
        settings: [
          {
            key: 'respondentReport.generation.useClientKnowledge',
            label: 'Client knowledge grounding',
            effect:
              "When on, the report is grounded in the attributed demo client's knowledge documents.",
          },
        ],
      },
      next: ['generate'],
    }),
    node({
      id: 'generate',
      name: 'Write report',
      type: 'agent_call',
      x: 660,
      y: 0,
      description:
        'The reasoning model writes the report from the transcript and any retrieved knowledge — the substantive drafting pass.',
      meta: {
        agentSlug: RESPONDENT_REPORT_AGENT_SLUG,
        note: 'The reasoning model writes the report.',
        settings: [
          {
            key: 'respondentReport.mode',
            label: 'Report mode',
            effect:
              "raw / raw_plus_insights / narrative — only the latter two invoke the AI writer; 'raw' is deterministic.",
          },
        ],
      },
      next: ['format'],
    }),
    node({
      id: 'format',
      name: 'Format (optional)',
      type: 'agent_call',
      x: 880,
      y: 0,
      description:
        'An optional second-pass formatter tidies structure and presentation without changing the substance of the report.',
      meta: {
        agentSlug: REPORT_FORMATTER_AGENT_SLUG,
        note: 'Optional second-pass formatter.',
      },
      next: ['deliver'],
    }),
    node({
      id: 'deliver',
      name: 'Deliver report',
      type: 'report',
      x: 1100,
      y: 0,
      description: 'Persist and deliver the finished report to the respondent and admin surfaces.',
      meta: { note: 'Persist and deliver the finished report.' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.respondentReport) {
      return unavailable('Respondent reports are not enabled.');
    }
    if (!ctx.config.respondentReport.enabled) {
      return inactive('Respondent reports are turned off for this questionnaire.');
    }
    if (!isAiRespondentReportMode(ctx.config.respondentReport.mode)) {
      return inactive('This questionnaire uses the raw (non-AI) report mode.');
    }
    return applies('This questionnaire generates an AI respondent report.');
  },
});
