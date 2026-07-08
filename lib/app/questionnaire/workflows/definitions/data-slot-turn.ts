/**
 * Workflow diagram: Data-slot conversation (per turn).
 *
 * The data-slot-driven variant of the live loop
 * (`lib/app/questionnaire/orchestrator/data-slot-orchestrator.ts`). One combined
 * extraction fills both question answers and slot fills; a park gate synthesises
 * a provisional fill after too many attempts and bridges to a new theme; then the
 * turn branches to offer, a lagging question, or the next slot.
 */

import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const dataSlotTurnWorkflow = diagram({
  slug: 'data-slot-turn',
  title: 'Data-slot conversation (per turn)',
  description:
    'When a questionnaire has data slots, the interview flows by topic rather than by question order. A single extraction fills questions and slots at once; a park gate keeps things moving when a slot resists; and each turn chooses to wrap up, slip in a lagging required question, or move to the next slot.',
  sourceModule: 'lib/app/questionnaire/orchestrator/data-slot-orchestrator.ts',
  entryStepId: 'extract',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'extract',
      name: 'Extract (combined)',
      type: 'agent_call',
      x: 0,
      y: 0,
      description:
        'One combined extraction call fills both question answers and data-slot fills from the same message — the respondent never repeats themselves across the two views.',
      meta: {
        agentSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract-answer.data-slots',
        capabilitySlugs: [EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG],
        note: 'ONE combined call fills question answers AND data-slot fills.',
      },
      next: ['merge'],
    }),
    node({
      id: 'merge',
      name: 'Merge state',
      type: 'tool_call',
      x: 220,
      y: 0,
      description:
        'Merge the extracted answers and slot fills into the effective state so the rest of the turn reasons over one coherent picture.',
      meta: { note: 'Merge extracted intents into effective state.' },
      next: ['park'],
    }),
    node({
      id: 'park',
      name: 'Park gate',
      type: 'guard',
      x: 440,
      y: 0,
      description:
        'When a slot has resisted several attempts, synthesise a provisional fill and bridge to a new theme rather than badgering the respondent. Pass → continue.',
      meta: {
        note: 'After N attempts, synthesise a provisional fill and bridge to a new theme.',
      },
      next: [{ targetStepId: 'contradiction', condition: 'Pass' }],
    }),
    node({
      id: 'contradiction',
      name: 'Detect contradictions',
      type: 'agent_call',
      x: 660,
      y: 0,
      description:
        'The Contradiction Detector checks the newly filled slots against earlier answers for genuine conflicts to reconcile.',
      meta: {
        agentSlug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        promptSpecimenId: 'detect.probe',
        capabilitySlugs: [DETECT_CONTRADICTIONS_CAPABILITY_SLUG],
        note: 'Compare slot fills against earlier answers for genuine conflicts.',
      },
      next: ['respond'],
    }),
    node({
      id: 'respond',
      name: 'Decide next move',
      type: 'route',
      x: 880,
      y: 0,
      description:
        'Route the turn: Offer to wrap up, interleave a lagging required Question, or move to the Next slot.',
      config: {
        routes: [{ label: 'Offer' }, { label: 'Question' }, { label: 'Next slot' }],
      },
      next: [
        { targetStepId: 'offer', condition: 'Offer' },
        { targetStepId: 'question', condition: 'Question' },
        { targetStepId: 'nextslot', condition: 'Next slot' },
      ],
    }),
    node({
      id: 'offer',
      name: 'Offer to wrap up',
      type: 'agent_call',
      x: 1100,
      y: -120,
      description:
        'The Completion agent phrases the wrap-up offer when enough of the slots are satisfactorily filled.',
      meta: {
        agentSlug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
        promptSpecimenId: 'complete.stream',
        note: 'Phrases the wrap-up offer.',
      },
    }),
    node({
      id: 'question',
      name: 'Ask a lagging question',
      type: 'agent_call',
      x: 1100,
      y: 0,
      description:
        "The Interviewer interleaves a lagging required question that the topic-led flow has not yet covered, phrased in the run's voice.",
      meta: {
        agentSlug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        promptSpecimenId: 'interview.tone',
        note: 'Interleave a lagging required question.',
      },
    }),
    node({
      id: 'nextslot',
      name: 'Pick the next slot',
      type: 'agent_call',
      x: 1100,
      y: 120,
      description:
        'The Selector picks the next data slot to pursue — topic-local when a theme is in flight, or adaptive embedding-ranked to find the most relevant next fact.',
      meta: {
        agentSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        promptSpecimenId: 'select.pick',
        note: 'Pick the next data slot — topic-local or adaptive embedding-ranked.',
      },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.dataSlots) {
      return unavailable('Data slots are not enabled.');
    }
    if (ctx.dataSlotCount === 0) {
      return inactive('This version has no data slots.');
    }
    if (ctx.versionStatus !== 'launched') {
      return inactive('Launch this version to run live.');
    }
    return applies('This launched version has data slots — the interview flows by topic.');
  },
});
