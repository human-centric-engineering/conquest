/**
 * Workflow diagram: Respondent report.
 *
 * The per-respondent AI report pipeline (`lib/app/questionnaire/report/generate.ts`). Load the
 * captured answers, build the transcript (grounded in the goal + full structured audience), optionally
 * ground in a demo client's knowledge base, optionally run web-search research rounds *before*
 * writing, a reasoning model writes the report, an optional formatter polishes it, optional *after*
 * research enriches/verifies it, then it is delivered — optionally with the respondent's own
 * questionnaire data appended. Shown only when the questionnaire is in an AI report mode.
 */

import {
  REPORT_FORMATTER_AGENT_SLUG,
  REPORT_RESEARCHER_AGENT_SLUG,
  RESPONDENT_REPORT_AGENT_SLUG,
  WEB_SEARCH_CAPABILITY_SLUG,
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
        'Assemble the ordered question-and-answer transcript and a completion percentage — the factual base the report is written from. The transcript leads with the questionnaire context for grounding: title, goal, and the full structured audience (description, role, expertise, duration, locale, sensitivity, notes) — every field the admin set, each on its own labelled line.',
      meta: {
        note: 'Build the Q&A transcript + completion %; grounds on the full structured audience.',
      },
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
      next: ['before-research'],
    }),
    node({
      id: 'before-research',
      name: 'Research — before (optional)',
      type: 'agent_call',
      x: 660,
      y: 0,
      description:
        'Optional web-search rounds that gather live external context BEFORE the report is written. A dedicated research agent drives a bounded tool-loop — each round it sees the accumulated results and issues a refined query — and writes a short synthesis note. When "let findings inform the report" is on, the findings are handed to the writer as general background (never attributed to the respondent). Best-effort: a missing search backend or any error yields whatever was gathered, never failing the report.',
      meta: {
        agentSlug: REPORT_RESEARCHER_AGENT_SLUG,
        capabilitySlugs: [WEB_SEARCH_CAPABILITY_SLUG],
        note: 'Optional. Report Research agent → bounded web_search tool-loop; runs when timing is "before" or "both". Prompt built in code, not catalogued.',
        settings: [
          {
            key: 'respondentReport.research.enabled',
            label: 'Web-search rounds',
            effect: 'Master toggle for this version’s report web-search research.',
          },
          {
            key: 'respondentReport.research.timing',
            label: 'When to search',
            effect: 'This "before" phase runs when timing is "before" or "both".',
          },
          {
            key: 'respondentReport.research.informNarrative',
            label: 'Let findings inform the report',
            effect:
              'When on, the before-findings are given to the writer as general background context.',
          },
        ],
      },
      next: ['generate'],
    }),
    node({
      id: 'generate',
      name: 'Write report',
      type: 'agent_call',
      x: 880,
      y: 0,
      description:
        'The reasoning model writes the report from the transcript, any retrieved knowledge, and (when enabled) the before-research background. When the report will also append the raw questionnaire data, the writer is told the respondent can already see their answers, so it analyses and synthesises rather than restating them.',
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
          {
            key: 'respondentReport.generation.narrativeStyle',
            label: 'Narrative style',
            effect: 'Shapes prose density/format (flowing / concise / structured).',
          },
        ],
      },
      next: ['format'],
    }),
    node({
      id: 'format',
      name: 'Format (optional)',
      type: 'agent_call',
      x: 1100,
      y: 0,
      description:
        'An optional second-pass formatter tidies structure and presentation without changing the substance of the report.',
      meta: {
        agentSlug: REPORT_FORMATTER_AGENT_SLUG,
        note: 'Optional second-pass formatter.',
      },
      next: ['after-research'],
    }),
    node({
      id: 'after-research',
      name: 'Research — after (optional)',
      type: 'agent_call',
      x: 1320,
      y: 0,
      description:
        'Optional web-search rounds that research the FINISHED report to enrich or fact-check it — the research agent runs the same bounded tool-loop over the drafted report text. The combined before + after findings are deduped by URL and attached to the report as a Research / Sources section (unless the display is set to hidden).',
      meta: {
        agentSlug: REPORT_RESEARCHER_AGENT_SLUG,
        capabilitySlugs: [WEB_SEARCH_CAPABILITY_SLUG],
        note: 'Optional. Runs when timing is "after" or "both" and its findings can surface (shown, or fed into the appendix); attaches the Research section.',
        settings: [
          {
            key: 'respondentReport.research.timing',
            label: 'When to search',
            effect: 'This "after" phase runs when timing is "after" or "both".',
          },
          {
            key: 'respondentReport.research.display',
            label: 'Show findings as',
            effect: 'table / list / hidden — how the Research / Sources section renders.',
          },
        ],
      },
      next: ['appendix'],
    }),
    node({
      id: 'appendix',
      name: 'Synthesize appendix (optional)',
      type: 'agent_call',
      x: 1540,
      y: 0,
      description:
        'Optional final pass: when the admin opts in AND at least one web-search finding was gathered, the report writer synthesises a short supporting appendix from the combined before + after findings and the finished report — general supporting context, grounded in the sources and never attributed to the respondent. Skipped (no-op) when no findings exist. Reuses the report writer agent.',
      meta: {
        agentSlug: RESPONDENT_REPORT_AGENT_SLUG,
        note: 'Optional. Reuses the report writer to synthesise a supporting appendix from the web-search findings; only when the toggle is on and findings exist.',
        settings: [
          {
            key: 'respondentReport.research.appendix',
            label: 'Synthesize a supporting appendix',
            effect:
              'When on, a supporting appendix is written from the research findings (only if any were gathered).',
          },
        ],
      },
      next: ['deliver'],
    }),
    node({
      id: 'deliver',
      name: 'Deliver report',
      type: 'report',
      x: 1760,
      y: 0,
      description:
        'Persist and deliver the finished report to the respondent and admin surfaces. Per config, the respondent’s own questionnaire data can be appended beneath the report — a questions-and-answers recap and/or the captured data-slot values — shown on the completion screen and in the downloadable PDF alike.',
      meta: {
        note: 'Persist and deliver; optionally append the respondent’s questionnaire data.',
        settings: [
          {
            key: 'respondentReport.rawIncludes.questionsAsPresented',
            label: 'Include questions & answers',
            effect: 'Appends the question-by-question answer record beneath the report.',
          },
          {
            key: 'respondentReport.rawIncludes.dataSlots',
            label: 'Include captured data-slot values',
            effect:
              'Appends the captured data-slot values (respondent-facing paraphrases) beneath the report.',
          },
        ],
      },
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
