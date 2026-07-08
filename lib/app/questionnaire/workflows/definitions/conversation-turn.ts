/**
 * Workflow diagram: Conversational run (per turn).
 *
 * The flagship pipeline — every respondent message runs through the orchestrator
 * in `lib/app/questionnaire/orchestrator/orchestrator.ts`. Extract typed answers,
 * clear the safety gates, merge state, reconcile contradictions, assess
 * completion, then branch: ask the next question, offer to wrap up, or complete.
 * Runs only on launched versions.
 */

import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const conversationTurnWorkflow = diagram({
  slug: 'conversation-turn',
  title: 'Conversational run (per turn)',
  description:
    'This is the heart of ConQuest. Every message a respondent sends runs the full loop: pull out typed answers, clear the safety and genuineness gates, reconcile anything that contradicts an earlier answer, judge whether enough has been captured, then decide what to say next — a warm follow-up question, an offer to wrap up, or completion.',
  sourceModule: 'lib/app/questionnaire/orchestrator/orchestrator.ts',
  entryStepId: 'extract',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'extract',
      name: 'Extract answers',
      type: 'agent_call',
      x: 0,
      y: 0,
      description:
        'The Answer Extractor reads the respondent message and returns typed answers with confidence and provenance — turning free prose into structured data.',
      meta: {
        agentSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract-answer.question',
        capabilitySlugs: [EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG],
        note: 'Turns the respondent message into typed answers.',
      },
      next: ['sensitivity'],
    }),
    node({
      id: 'sensitivity',
      name: 'Sensitivity gate',
      type: 'guard',
      x: 220,
      y: 0,
      description:
        'A keyword floor plus a detector spot genuine sensitive disclosures and signpost support when needed — without derailing the interview. Pass → continue.',
      meta: {
        note: 'Keyword floor + detector; signposts support if a sensitive disclosure is genuine.',
      },
      next: [{ targetStepId: 'seriousness', condition: 'Pass' }],
    }),
    node({
      id: 'seriousness',
      name: 'Genuineness gate',
      type: 'guard',
      x: 440,
      y: 0,
      description:
        "A genuineness check — a keyword floor, or an LLM judge run under the extractor's binding — filters non-serious input; repeated strikes abandon abusive sessions. Pass → continue.",
      meta: {
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract-answer.seriousness',
        note: "Genuineness gate: keyword floor OR an LLM judge run under the extractor's binding; strikes abandon abusive sessions.",
      },
      next: [{ targetStepId: 'merge', condition: 'Pass' }],
    }),
    node({
      id: 'merge',
      name: 'Merge state',
      type: 'tool_call',
      x: 660,
      y: 0,
      description:
        'Merge the freshly extracted intents into the effective answer state, so downstream steps reason over one coherent view of everything captured so far.',
      meta: { note: 'Merge intents into effective state.' },
      next: ['contradiction'],
    }),
    node({
      id: 'contradiction',
      name: 'Detect contradictions',
      type: 'agent_call',
      x: 880,
      y: 0,
      description:
        'The Contradiction Detector compares answers across slots for genuine conflicts — a later answer that undercuts an earlier one — so the interview can reconcile rather than quietly store both.',
      meta: {
        agentSlug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        promptSpecimenId: 'detect.probe',
        capabilitySlugs: [DETECT_CONTRADICTIONS_CAPABILITY_SLUG],
        note: 'Compare answers across slots for genuine conflicts.',
      },
      next: ['refine'],
    }),
    node({
      id: 'refine',
      name: 'Refine answer',
      type: 'agent_call',
      x: 1100,
      y: 0,
      description:
        "When a conflict is reconciled in conversation, the Answer Refiner updates the earlier answer in place so the captured record reflects the respondent's settled position.",
      meta: {
        agentSlug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
        promptSpecimenId: 'refine.triggered',
        capabilitySlugs: [REFINE_ANSWER_CAPABILITY_SLUG],
        note: 'Update an earlier answer when a conflict is reconciled.',
      },
      next: ['assess'],
    }),
    node({
      id: 'assess',
      name: 'Assess completion',
      type: 'evaluate',
      x: 1320,
      y: 0,
      description:
        'A deterministic, free completion assessment scores how much of the questionnaire is genuinely answered — the signal that decides whether to keep asking or offer to wrap up.',
      meta: {
        note: 'Deterministic, free completion assessment — decides whether enough is answered.',
      },
      next: ['respond'],
    }),
    node({
      id: 'respond',
      name: 'Decide next move',
      type: 'route',
      x: 1540,
      y: 0,
      description:
        'Route on the assessment: keep going with the next Question, make an Offer to wrap up, or mark the run Complete.',
      config: {
        routes: [{ label: 'Question' }, { label: 'Offer' }, { label: 'Complete' }],
      },
      next: [
        { targetStepId: 'select', condition: 'Question' },
        { targetStepId: 'offer', condition: 'Offer' },
        { targetStepId: 'done', condition: 'Complete' },
      ],
    }),
    node({
      id: 'select',
      name: 'Select next question',
      type: 'agent_call',
      x: 1760,
      y: -120,
      description:
        "The Selector ranks the remaining candidates under the active strategy and picks what should flow next — the adaptive brain behind the interview's order.",
      meta: {
        agentSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        promptSpecimenId: 'select.pick',
        note: 'Adaptive strategy ranks candidates and picks what flows next.',
      },
      next: ['ask'],
    }),
    node({
      id: 'ask',
      name: 'Ask the question',
      type: 'agent_call',
      x: 1980,
      y: -120,
      description:
        'The Interviewer phrases the chosen question as warm, natural prose. Persona, tone, and voice all apply here — this is the voice the respondent hears.',
      meta: {
        agentSlug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        promptSpecimenId: 'interview.tone',
        note: 'Phrases the next question as warm prose; persona/tone/voice apply here.',
      },
    }),
    node({
      id: 'offer',
      name: 'Offer to wrap up',
      type: 'agent_call',
      x: 1760,
      y: 0,
      description:
        'The Completion agent phrases the wrap-up offer — inviting the respondent to finish now while leaving the door open to add more.',
      meta: {
        agentSlug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
        promptSpecimenId: 'complete.stream',
        capabilitySlugs: [COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG],
        note: 'Phrases the wrap-up offer.',
      },
    }),
    node({
      id: 'done',
      name: 'Complete',
      type: 'report',
      x: 1760,
      y: 120,
      description:
        'The questionnaire is complete — the captured answers are finalised and any downstream reporting can run.',
      meta: { note: 'The questionnaire is complete.' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.liveSessions) {
      return unavailable('Live sessions are not enabled.');
    }
    if (ctx.versionStatus === 'launched') {
      return applies('This version is launched — live conversations run this loop.');
    }
    return inactive('Launch this version to run live conversations.');
  },
});
