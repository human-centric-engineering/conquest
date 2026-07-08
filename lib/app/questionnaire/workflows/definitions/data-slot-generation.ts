/**
 * Workflow diagram: Data-slot Generation.
 *
 * Documents the authoring-assist that proposes data slots from the authored
 * structure (`lib/app/questionnaire/data-slots/generation.ts`). The questions go
 * in (no respondent PII), the generator proposes typed slots, and the admin
 * reviews before anything persists. Version-agnostic authoring aid.
 */

import {
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

import { applies, diagram, node, unavailable } from '@/lib/app/questionnaire/workflows/types';

export const dataSlotGenerationWorkflow = diagram({
  slug: 'data-slot-generation',
  title: 'Data-slot generation',
  description:
    'Data slots are the atomic facts a conversation aims to capture. Point the generator at your questions and it proposes a typed set of slots for you to review — the scaffolding that lets the interview flow by topic rather than by rigid question order.',
  sourceModule: 'lib/app/questionnaire/data-slots/generation.ts',
  entryStepId: 'structure',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'structure',
      name: 'Read the structure',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Feed the authored sections and questions to the generator as context. Only the questionnaire design is used — no respondent answers or PII are involved.',
      meta: { note: 'The authored questions — no PII.' },
      next: ['generate'],
    }),
    node({
      id: 'generate',
      name: 'Generate data slots',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'The Data-slot Generator proposes a set of typed, named slots derived from the questions, each with the type and metadata the live extractor will fill.',
      meta: {
        agentSlug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
        promptSpecimenId: 'data-slots.generate',
        capabilitySlugs: [GENERATE_DATA_SLOTS_CAPABILITY_SLUG],
        note: 'The one LLM call — proposes typed slots from the questions.',
      },
      next: ['review'],
    }),
    node({
      id: 'review',
      name: 'Admin reviews',
      type: 'human_approval',
      x: 440,
      y: 0,
      description:
        'The admin reviews the proposed slots, editing or discarding freely. Nothing persists until the admin saves — the generator only ever suggests.',
      meta: { note: 'Admin reviews proposed slots; nothing persists until saved.' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.dataSlots) {
      return unavailable('Data slots are not enabled.');
    }
    return applies('An authoring aid — available on any version to propose data slots.');
  },
});
