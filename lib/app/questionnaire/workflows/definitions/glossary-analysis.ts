/**
 * Workflow diagram: Glossary Analysis (definitions / glossary, P16).
 *
 * Documents the authoring-assist that proposes the terms a questionnaire leans on whose meaning
 * is not settled, and what happens to them once an admin accepts one. The last node is the point
 * of the whole feature: an accepted definition is not a note filed away, it is injected into every
 * agent that asks, interprets, or reports on an answer, and shown to the respondent inline.
 */

import {
  ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG,
  QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

export const glossaryAnalysisWorkflow = diagram({
  slug: 'glossary-analysis',
  title: 'Glossary analysis',
  description: 'Find the terms that need defining — and put those definitions to work.',
  sourceModule: 'lib/app/questionnaire/glossary/analysis-prompt.ts',
  entryStepId: 'gather',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'gather',
      name: 'Read the questionnaire',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Collect the goal, audience, every question and its guidance, and the data slots — plus the authoritative definitions document when one is attached. Terms already accepted or rejected are listed too, so the analyst is told not to raise them again. Only the questionnaire design is used; no respondent answers or PII are involved.',
      meta: { note: 'The authored questions + any definitions document — no PII.' },
      next: ['analyse'],
    }),
    node({
      id: 'analyse',
      name: 'Propose terms',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'The Glossary Analyst identifies terms whose meaning is genuinely open to interpretation here, and proposes the readings this questionnaire appears to intend. Where a definitions document was supplied it is authoritative and its wording wins, quoted for provenance. Precision is favoured over recall — an empty result is a valid answer.',
      meta: {
        agentSlug: QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
        promptSpecimenId: 'glossary.default',
        capabilitySlugs: [ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG],
        note: 'The one LLM call — proposes terms + candidate definitions.',
      },
      next: ['persist'],
    }),
    node({
      id: 'persist',
      name: 'Save as proposals',
      type: 'tool_call',
      x: 440,
      y: 0,
      description:
        'Proposals are written as `proposed` terms with nothing pre-ticked. Terms already accepted or rejected are left untouched and any re-suggestion of them is dropped, so the analysis is safe to re-run. Because a proposal is inert, this write never forks a launched version.',
      meta: { note: 'Proposals only — inert until an admin accepts them.' },
      next: ['curate'],
    }),
    node({
      id: 'curate',
      name: 'Admin curates',
      type: 'human_approval',
      x: 660,
      y: 0,
      description:
        'The admin accepts or rejects each term and ticks the reading(s) that apply — more than one when the term genuinely carries several senses here. Wording can be edited, and terms added by hand. Nothing is in use until this is saved, and saving a launched version forks a new draft.',
      meta: { note: 'Nothing is in use until the admin accepts and saves.' },
      next: ['apply'],
    }),
    node({
      id: 'apply',
      name: 'Put the definitions to work',
      type: 'tool_call',
      x: 880,
      y: 0,
      description:
        'Accepted terms relevant to the current turn are folded into the interviewer, answer-extraction, refinement and contradiction-detection prompts, and the whole set into report generation. Respondents see matched terms underlined with the definition in a popover, and the glossary can be appended to their report.',
      meta: {
        note: 'One definition, every surface — prompts, respondent hints, report appendix.',
        settings: [
          {
            key: 'glossaryPromptInjection',
            label: 'Definitions in prompts',
            effect:
              'Folds the terms relevant to the current turn into the interviewer, extraction, refinement and contradiction prompts, and the whole set into report generation.',
          },
          {
            key: 'glossaryRespondentHints',
            label: 'Respondent hints',
            effect:
              'Underlines a defined term the first time it appears in a message and on form labels, with the definition in a popover.',
          },
          {
            key: 'glossaryReportAppendix',
            label: 'Report glossary appendix',
            effect:
              'Appends the accepted terms and definitions to the respondent report and its PDF. Off by default.',
          },
        ],
      },
    }),
  ],
  applicability: () =>
    applies('An authoring aid — available on any version with questions to analyse.'),
});
