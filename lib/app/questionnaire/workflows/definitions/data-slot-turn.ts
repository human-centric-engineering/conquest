/**
 * Workflow diagram: Data-slot conversation (per turn).
 *
 * The data-slot-driven variant of the live loop
 * (`lib/app/questionnaire/orchestrator/data-slot-orchestrator.ts`). One combined
 * extraction fills both question answers and slot fills; the safety gates
 * (sensitivity + genuineness) clear in parity with question mode before merge; a
 * park gate synthesises a provisional fill after too many attempts and bridges to
 * a new theme; then the turn branches to offer, a lagging question, or the next
 * slot.
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
        vector: {
          status: 'pluggable',
          description:
            'At scale a pgvector pre-filter embeds the message and narrows the combined question + data-slot candidate set handed to the extractor to the top-K most similar (plus safety-rail slots) — behaviour-preserving and fail-soft.',
        },
        note: 'ONE combined call fills question answers AND data-slot fills.',
        settings: [
          {
            key: 'answerFitMode',
            label: 'Answer fit mode',
            effect:
              'Controls free-text→option mapping for question answers filled alongside slots.',
          },
        ],
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
        'A hybrid safeguarding gate — parity with question mode: a deterministic keyword floor AND a dedicated LLM detector (plus the extractor’s own signal) spot genuine sensitive disclosures and signpost support. Runs before merge so a genuine disclosure is never judged for sincerity or struck. Pass → continue.',
      meta: {
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract-answer.sensitivity-detector',
        hybrid: true,
        note: 'Keyword floor + dedicated LLM detector + extractor field, merged (defence-in-depth); signposts support once per session on a genuine high-severity disclosure.',
        settings: [
          {
            key: 'sensitivityAwareness',
            label: 'Sensitivity awareness',
            effect: 'Enables safeguarding detection and signposting on sensitive disclosures.',
          },
          {
            key: 'supportMessage',
            label: 'Support message',
            effect: 'The supportive message shown when a sensitive disclosure is detected.',
          },
          {
            key: 'supportResourceUrl',
            label: 'Support resource link',
            effect: 'Optional help link offered alongside the support message.',
          },
        ],
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
        "A genuineness check — parity with question mode: a keyword abuse floor, or an LLM judge run under the extractor's binding, filters non-serious input; repeated strikes abandon abusive sessions. Skipped when the turn was a genuine disclosure (safeguarding outranks the sincerity gate). Pass → continue.",
      meta: {
        promptCatalogSlug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        promptSpecimenId: 'extract-answer.seriousness',
        hybrid: true,
        note: "Genuineness gate: keyword abuse floor OR an LLM judge run under the extractor's binding; strikes abandon abusive sessions.",
        settings: [
          {
            key: 'abuseThreshold',
            label: 'Abuse threshold',
            effect:
              'Number of non-genuine strikes before the session is abandoned; 0 turns the gate off.',
          },
        ],
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
        'Merge the extracted answers and slot fills into the effective state so the rest of the turn reasons over one coherent picture.',
      meta: { note: 'Merge extracted intents into effective state.' },
      next: ['park'],
    }),
    node({
      id: 'park',
      name: 'Park gate',
      type: 'guard',
      x: 880,
      y: 0,
      description:
        'When a slot has resisted several attempts, synthesise a provisional fill and bridge to a new theme rather than badgering the respondent. Pass → continue.',
      meta: {
        note: 'After N attempts, synthesise a provisional fill and bridge to a new theme.',
        settings: [
          {
            key: 'maxDataSlotAttempts',
            label: 'Max slot attempts',
            effect:
              "How many tries on a slot before it's parked with a provisional fill and the topic moves on.",
          },
        ],
      },
      next: [{ targetStepId: 'contradiction', condition: 'Pass' }],
    }),
    node({
      id: 'contradiction',
      name: 'Detect contradictions',
      type: 'agent_call',
      x: 1100,
      y: 0,
      description:
        'The Contradiction Detector checks the newly filled slots against earlier answers for genuine conflicts to reconcile.',
      meta: {
        agentSlug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
        promptSpecimenId: 'detect.probe',
        capabilitySlugs: [DETECT_CONTRADICTIONS_CAPABILITY_SLUG],
        note: 'Compare slot fills against earlier answers for genuine conflicts.',
        settings: [
          {
            key: 'contradictionMode',
            label: 'Contradiction mode',
            effect: 'off / flag / probe — how conflicts across captured answers are handled.',
          },
        ],
      },
      next: ['respond'],
    }),
    node({
      id: 'respond',
      name: 'Decide next move',
      type: 'route',
      x: 1320,
      y: 0,
      description:
        'Route the turn: Offer to wrap up, interleave a lagging required Question, or move to the Next slot.',
      config: {
        routes: [{ label: 'Offer' }, { label: 'Question' }, { label: 'Next slot' }],
      },
      meta: {
        settings: [
          {
            key: 'presentationMode',
            label: 'Presentation mode',
            effect: 'chat / form / both — shapes delivery of the next prompt.',
          },
        ],
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
      x: 1540,
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
      x: 1540,
      y: 0,
      description:
        "The Interviewer interleaves a lagging required question that the topic-led flow has not yet covered, phrased in the run's voice.",
      meta: {
        agentSlug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
        promptSpecimenId: 'interview.tone',
        note: 'Interleave a lagging required question.',
        settings: [
          {
            key: 'tone',
            label: 'Interviewer tone',
            effect: 'Tone dials shape phrasing when a lagging required question is interleaved.',
          },
          {
            key: 'personaSelection.enabled',
            label: 'Interviewer personas',
            effect: 'A chosen persona replaces the tone dials for phrasing.',
          },
        ],
      },
    }),
    node({
      id: 'nextslot',
      name: 'Pick the next slot',
      type: 'agent_call',
      x: 1540,
      y: 120,
      description:
        'The Selector picks the next data slot to pursue — topic-local when a theme is in flight, or adaptive embedding-ranked to find the most relevant next fact.',
      meta: {
        agentSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        promptCatalogSlug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        promptSpecimenId: 'select.pick',
        vector: {
          status: 'active',
          description:
            'When no theme is in flight, the adaptive path embeds the conversation and ranks the open data slots by pgvector similarity to find the most relevant next fact to pursue (the "Adaptive data-slot ranking" embedding call).',
        },
        note: 'Pick the next data slot — topic-local or adaptive embedding-ranked.',
        settings: [
          {
            key: 'selectionStrategy',
            label: 'Selection strategy',
            effect:
              "'adaptive' enables embedding-ranked next-slot selection; otherwise slots are picked topic-locally.",
          },
        ],
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
