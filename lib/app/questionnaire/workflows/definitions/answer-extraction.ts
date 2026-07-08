/**
 * Workflow diagram: Answer extraction & mapping.
 *
 * A close-up on the extraction stage of a live run
 * (`lib/app/questionnaire/extraction/extraction-prompt.ts`): the message goes to
 * the extractor, structural then semantic validation drop bad answers, and
 * confidence forward-propagates from data-slot fills to mapped question keys.
 * Runs inside a launched conversation.
 */

import {
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const answerExtractionWorkflow = diagram({
  slug: 'answer-extraction',
  title: 'Answer extraction & mapping',
  description:
    'How a free-text reply becomes structured data. The extractor returns typed answers with confidence and provenance; a structural pass and per-type semantic validation drop anything that does not hold up; and confidence propagates from data-slot fills onto the questions they map to.',
  sourceModule: 'lib/app/questionnaire/extraction/extraction-prompt.ts',
  entryStepId: 'message',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'message',
      name: 'Respondent message',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        "The respondent's latest reply enters, alongside the active question and slot context the extractor needs to interpret it.",
      meta: { note: 'The inbound reply plus its question/slot context.' },
      next: ['extract'],
    }),
    node({
      id: 'extract',
      name: 'Extract answers',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'The Answer Extractor returns typed answers, each carrying a confidence score and provenance pointing back at the span of the message it came from.',
      meta: {
        agentSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract-answer.question',
        capabilitySlugs: [EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG],
        vector: {
          status: 'pluggable',
          description:
            'At scale a pgvector pre-filter embeds the reply and narrows the candidate slots sent to the extractor to the top-K most similar (plus safety-rail slots) — the extraction sibling of adaptive selection, behaviour-preserving and fail-soft.',
        },
        note: 'LLM returns typed answers + confidence + provenance.',
        settings: [
          {
            key: 'answerFitMode',
            label: 'Answer fit mode',
            effect:
              'off / fallback / always — whether a second pass maps free text onto choice/likert options.',
          },
          {
            key: 'attachmentsEnabled',
            label: 'Attachments',
            effect: 'When on, attached images/documents are included in extraction.',
          },
        ],
      },
      next: ['normalize'],
    }),
    node({
      id: 'normalize',
      name: 'Normalise',
      type: 'tool_call',
      x: 440,
      y: 0,
      description:
        'A Zod structural pass shapes the model output and drops individual malformed answers without failing the whole turn — one bad field never sinks the rest.',
      meta: { note: 'Zod structural pass; drop individual bad answers.' },
      next: ['validate'],
    }),
    node({
      id: 'validate',
      name: 'Validate',
      type: 'guard',
      x: 660,
      y: 0,
      description:
        "Semantic per-type validation checks each answer against the slot's real typeConfig — a date is a valid date, a choice is an allowed option. Pass → propagate.",
      meta: {
        note: "Semantic per-type validation against the slot's real typeConfig.",
        settings: [
          {
            key: 'answerFitMode',
            label: 'Answer fit mode',
            effect:
              "In 'fallback'/'always' mode, unmatched free text is force-fit to the closest option here.",
          },
        ],
      },
      next: [{ targetStepId: 'propagate', condition: 'Pass' }],
    }),
    node({
      id: 'propagate',
      name: 'Propagate confidence',
      type: 'tool_call',
      x: 880,
      y: 0,
      description:
        'Forward-propagate from data-slot fills onto the question keys they map to, accruing confidence where independent answers corroborate the same fact.',
      meta: {
        note: 'Forward-propagate from data-slot fills to mapped question keys; accrue confidence on corroboration.',
      },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.answerExtraction) {
      return unavailable('Answer extraction is not enabled.');
    }
    if (ctx.versionStatus === 'launched') {
      return applies('This version is launched — extraction runs on every reply.');
    }
    return inactive('Runs inside a live run — launch this version to see it.');
  },
});
