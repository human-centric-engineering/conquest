/**
 * Workflow diagram: Generative Authoring.
 *
 * Documents the admin "describe it in plain English → get a full questionnaire"
 * pipeline in `lib/app/questionnaire/ingestion/stream-compose.ts`. A brief is
 * turned into an outline, sections are drafted in parallel, assembled and
 * de-duped, then persisted — and each subsequent conversational tweak re-writes
 * the draft. The composed sibling of document ingestion.
 */

import {
  COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
  REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const generativeAuthoringWorkflow = diagram({
  slug: 'generative-authoring',
  title: 'Generative authoring',
  description:
    'No document? Describe the questionnaire in a sentence or two and an agent composes the whole thing — a goal, an audience, sections, and typed questions — then keeps refining it as you chat.',
  sourceModule: 'lib/app/questionnaire/ingestion/stream-compose.ts',
  entryStepId: 'brief',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'brief',
      name: 'Read the brief',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        "Take the admin's plain-English brief and any supplied goal or audience, and prepare the composition request. No structure exists yet.",
      meta: { note: "The admin's plain-English brief." },
      next: ['outline'],
    }),
    node({
      id: 'outline',
      name: 'Compose outline',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'The Composer drafts the overall shape in one pass — an inferred goal and audience plus a section outline — establishing the skeleton the section calls fill in.',
      meta: {
        agentSlug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        promptSpecimenId: 'compose.outline',
        capabilitySlugs: [COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG],
        note: 'The first LLM pass — goal, audience, and section outline (streaming phase 1).',
      },
      next: ['sections'],
    }),
    node({
      id: 'sections',
      name: 'Draft sections',
      type: 'parallel',
      x: 440,
      y: 0,
      description:
        'Each section is drafted by its own structured Composer call, fanned out in parallel so a long questionnaire composes as fast as a short one.',
      meta: {
        agentSlug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        promptSpecimenId: 'compose.sections',
        capabilitySlugs: [COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG],
        note: 'One structured call per section, 4 in parallel (phase 2 of the same compose capability).',
      },
      config: { branches: [{}, {}, {}] },
      next: ['assemble'],
    }),
    node({
      id: 'assemble',
      name: 'Assemble draft',
      type: 'tool_call',
      x: 660,
      y: 0,
      description:
        'Stitch the section drafts into one questionnaire — de-dupe question keys, force section ordinals, and run a coherence check so the parts read as a whole.',
      meta: { note: 'De-dupe question keys, force section ordinals, coherence check.' },
      next: ['persist'],
    }),
    node({
      id: 'persist',
      name: 'Persist questionnaire',
      type: 'report',
      x: 880,
      y: 0,
      description:
        'Write the composed section/question graph as a new questionnaire and draft version, recording the brief as its provenance. The admin can now review, edit, or refine.',
      meta: { note: 'Deterministic write — the draft is ready to review or refine.' },
      next: ['refine'],
    }),
    node({
      id: 'refine',
      name: 'Conversational refine',
      type: 'agent_call',
      x: 1100,
      y: 0,
      description:
        'Every follow-up instruction — "make it shorter", "add a section on pricing" — is a fresh Composer turn that re-writes the working draft in place.',
      meta: {
        agentSlug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
        promptSpecimenId: 'compose.refine',
        capabilitySlugs: [REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG],
        note: "Each conversational 'make it shorter' turn re-writes the draft via the refine capability.",
      },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.generativeAuthoring) {
      return unavailable('Generative authoring is not enabled.');
    }
    if (ctx.sourceDocumentCount === 0 && ctx.goalProvenance === 'inferred') {
      return applies('This version was composed from a brief.');
    }
    return inactive('This version was ingested from a document, not composed from a brief.');
  },
});
