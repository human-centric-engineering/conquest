/**
 * Prompt catalog — the single source of truth for the admin "Prompt Library".
 *
 * WHY THIS EXISTS. Every questionnaire agent is dispatched *programmatically*: the
 * load-bearing system prompt is assembled in a TypeScript builder (e.g.
 * `buildAnswerExtractionPrompt`), NOT read from the agent's editable
 * `AiAgent.systemInstructions` field (which is descriptive only — see each agent
 * seed's header comment). That makes the real prompts invisible to an operator
 * reading the admin agent form. This catalog closes that gap: it invokes each real
 * builder with a fixed, representative SAMPLE context and returns the exact messages
 * we would send the model, so an admin can read the prompts we actually use.
 *
 * Pure + server-only: it imports the real builders (some of which pull server deps)
 * and is consumed only by the `prompts` route, which layers on each agent's DB row
 * (provider/model binding, budget, the inert stored instructions). Each specimen is
 * built behind a try/catch so one bad sample can never 500 the page.
 */

import { getTextContent, type LlmMessage } from '@/lib/orchestration/llm/types';

import { buildExtractionPrompt } from '@/lib/app/questionnaire/ingestion/extraction-prompt';
import {
  buildComposeFullPrompt,
  buildRefineStructurePrompt,
} from '@/lib/app/questionnaire/ingestion/compose-prompt';
import { buildAnswerExtractionPrompt } from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { buildContradictionDetectionPrompt } from '@/lib/app/questionnaire/contradiction/detection-prompt';
import { buildRefinementPrompt } from '@/lib/app/questionnaire/refinement/refinement-prompt';
import { buildCompletionOfferPrompt } from '@/lib/app/questionnaire/completion/completion-prompt';
import { buildSeriousnessJudgePrompt } from '@/lib/app/questionnaire/seriousness/judge-prompt';
import {
  buildDataSlotGenerationPrompt,
  buildDataSlotRefinementPrompt,
  buildDataSlotAssignmentPrompt,
} from '@/lib/app/questionnaire/data-slots/generation';
import { buildJudgePrompt } from '@/lib/app/questionnaire/evaluation/judge-prompt';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { DEFAULT_TONE_SETTINGS } from '@/lib/app/questionnaire/types';
import {
  EVALUATION_DIMENSIONS,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation/types';

import { buildStreamingQuestionPrompt } from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
import { buildStreamingOfferPrompt } from '@/app/api/v1/app/questionnaire-sessions/_lib/offer-stream';
import { buildSelectorPrompt } from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';

import {
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A single normalised chat turn (role + flattened text) ready to render. */
export interface CatalogMessage {
  role: string;
  content: string;
}

/** One representative rendering of an agent's prompt (a builder invocation). */
export interface PromptSpecimen {
  /** Stable id (used as the client tab key). */
  id: string;
  /** Short human label, e.g. "Per-turn extraction". */
  label: string;
  /** When this exact prompt is sent. */
  description: string;
  /** Runtime conditions this variant represents, e.g. ["Data Slots on"]. */
  conditions: string[];
  /** The exact messages the model receives for this specimen. */
  messages: CatalogMessage[];
  /** True when the sample failed to render (the message carries the error). */
  error?: boolean;
}

/** Which phase of the questionnaire lifecycle an agent runs in. */
export type PromptStage = 'authoring' | 'live' | 'evaluation';

/** A questionnaire agent and the real prompt(s) it sends — DB-free. */
export interface PromptAgentCatalogEntry {
  slug: string;
  name: string;
  stage: PromptStage;
  summary: string;
  /** How/when the agent is invoked (plain English). */
  dispatch: string;
  /** Source module the load-bearing prompt is authored in (for "read the code"). */
  builderModule: string;
  /**
   * Whether the agent's editable `systemInstructions` field drives the prompt. False
   * for every questionnaire agent — the prompt is assembled in code. Surfaced so the
   * admin understands the stored field is descriptive, not load-bearing.
   */
  instructionsAreLoadBearing: boolean;
  specimens: PromptSpecimen[];
}

/** The agent's seeded DB binding, merged in by the route. */
export interface PromptAgentBinding {
  provider: string;
  model: string;
  /** True when provider+model are empty (resolved at runtime by agent-resolver). */
  resolvesAtRuntime: boolean;
  temperature: number | null;
  maxTokens: number | null;
  monthlyBudgetUsd: number | null;
  visibility: string | null;
  isActive: boolean;
}

/** A catalog entry enriched with its DB row — the API/page/client view. */
export interface PromptAgentApiView extends PromptAgentCatalogEntry {
  /** Whether a seeded `AiAgent` row exists for this slug. */
  seeded: boolean;
  binding: PromptAgentBinding | null;
  /** The inert stored instructions, shown so the admin can see it is NOT the prompt. */
  storedInstructions: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Flatten provider `LlmMessage[]` (string | ContentPart[]) into catalog turns. */
function norm(messages: LlmMessage[]): CatalogMessage[] {
  return messages.map((m) => ({ role: m.role, content: getTextContent(m.content) }));
}

/** Build a specimen, capturing any builder throw as a visible (non-fatal) error. */
function specimen(opts: {
  id: string;
  label: string;
  description: string;
  conditions?: string[];
  build: () => CatalogMessage[];
}): PromptSpecimen {
  const base = {
    id: opts.id,
    label: opts.label,
    description: opts.description,
    conditions: opts.conditions ?? [],
  };
  try {
    return { ...base, messages: opts.build() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      error: true,
      messages: [{ role: 'system', content: `⚠️ Sample prompt failed to render: ${detail}` }],
    };
  }
}

// ---------------------------------------------------------------------------
// Shared sample fixtures — small, realistic, gender-neutral
// ---------------------------------------------------------------------------

const SAMPLE_AUDIENCE = {
  role: 'Recent customer',
  expertiseLevel: 'intermediate' as const,
  locale: 'en-GB',
  sensitivity: 'low' as const,
};

const SAMPLE_VERSION_STRUCTURE: VersionStructureInput = {
  goal: 'Understand how new customers experience onboarding and where they get stuck.',
  audience: SAMPLE_AUDIENCE,
  sections: [
    {
      title: 'Getting started',
      description: 'The first run experience.',
      questions: [
        {
          key: 'setup_ease',
          prompt: 'How easy was it to set up the product?',
          type: 'likert',
          required: true,
          guidelines: 'A 1–5 scale where 5 is effortless.',
        },
        {
          key: 'setup_blockers',
          prompt: 'What, if anything, got in the way during setup?',
          type: 'free_text',
          required: false,
        },
      ],
    },
    {
      title: 'Support',
      questions: [
        {
          key: 'needed_help',
          prompt: 'Did you need to contact support to get going?',
          type: 'boolean',
          required: false,
        },
      ],
    },
  ],
};

const SAMPLE_DATA_SLOT_STRUCTURE = {
  goal: 'Understand how new customers experience onboarding.',
  questions: [
    { key: 'setup_ease', prompt: 'How easy was it to set up the product?', type: 'likert' },
    { key: 'setup_blockers', prompt: 'What got in the way during setup?', type: 'free_text' },
    { key: 'needed_help', prompt: 'Did you need to contact support?', type: 'boolean' },
  ],
};

// ---------------------------------------------------------------------------
// Authoring agents
// ---------------------------------------------------------------------------

const STRUCTURE_EXTRACTOR: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
  name: 'Structure Extractor',
  stage: 'authoring',
  summary:
    'Reads an uploaded document and proposes a structured questionnaire — sections, typed questions, an inferred goal/audience, and an editorial change log.',
  dispatch: 'Once per document upload, dispatched by the ingestion route.',
  builderModule: 'lib/app/questionnaire/ingestion/extraction-prompt.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'extract.default',
      label: 'Document ingestion',
      description: 'The prompt sent when an admin uploads a questionnaire document to extract.',
      build: () =>
        norm(
          buildExtractionPrompt({
            documentText:
              'Customer Onboarding Survey\n\n1. How easy was setup? (Very hard … Very easy)\n2. What got in the way?\n3. Did you contact support? (Yes/No)',
            fileName: 'onboarding-survey.pdf',
            mediaType: 'application/pdf',
            adminSupplied: {
              goal: 'Understand onboarding friction for new customers',
              audience: SAMPLE_AUDIENCE,
            },
          })
        ),
    }),
  ],
};

const COMPOSER: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
  name: 'Composer',
  stage: 'authoring',
  summary:
    'Generative authoring: composes a questionnaire from a plain-English brief (no source document), then refines it conversationally.',
  dispatch: 'On compose-from-brief and each conversational refine turn, by the compose routes.',
  builderModule: 'lib/app/questionnaire/ingestion/compose-prompt.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'compose.full',
      label: 'Compose from brief',
      description:
        'Sent when an admin describes a questionnaire in plain English and asks to build it.',
      build: () =>
        norm(
          buildComposeFullPrompt(
            'A short questionnaire for new customers about their onboarding experience: how easy setup was, what blocked them, and whether they needed support.',
            { goal: 'Understand onboarding friction', audience: SAMPLE_AUDIENCE }
          )
        ),
    }),
    specimen({
      id: 'compose.refine',
      label: 'Conversational refine',
      description:
        'Sent each time the admin asks to change the draft ("make it shorter", "add a pricing section").',
      build: () =>
        norm(
          buildRefineStructurePrompt(
            {
              sections: [
                { ordinal: 0, title: 'Getting started', description: 'First run experience.' },
              ],
              questions: [
                {
                  sectionOrdinal: 0,
                  key: 'setup_ease',
                  prompt: 'How easy was it to set up the product?',
                  suggestedType: 'likert',
                  extractionConfidence: 0.9,
                },
              ],
              inferredGoal: 'Understand onboarding friction',
              inferredAudience: SAMPLE_AUDIENCE,
            },
            'Add a short section about pricing clarity.'
          )
        ),
    }),
  ],
};

const DATA_SLOT_GENERATOR: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
  name: 'Data-Slot Generator',
  stage: 'authoring',
  summary:
    'Infers semantic data slots (short conversational targets) over a version’s questions, and refines or assigns them as the structure changes.',
  dispatch: 'On generate / refine / assign actions in the data-slots admin surface.',
  builderModule: 'lib/app/questionnaire/data-slots/generation.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'data-slots.generate',
      label: 'Generate slots',
      description: 'Proposes a full set of data slots from the approved questions.',
      build: () => norm(buildDataSlotGenerationPrompt(SAMPLE_DATA_SLOT_STRUCTURE, 'balanced')),
    }),
    specimen({
      id: 'data-slots.refine',
      label: 'Refine one slot',
      description: 'Rewrites a single slot per the admin’s free-text instruction.',
      build: () =>
        norm(
          buildDataSlotRefinementPrompt(
            SAMPLE_DATA_SLOT_STRUCTURE,
            {
              name: 'Setup friction',
              description: 'What made the initial setup hard or smooth.',
              theme: 'Onboarding',
              questionKeys: ['setup_ease', 'setup_blockers'],
            },
            'Focus on the emotional experience, not just speed.',
            [{ name: 'Support need', theme: 'Onboarding' }]
          )
        ),
    }),
    specimen({
      id: 'data-slots.assign',
      label: 'Assign new questions',
      description: 'Places newly-added questions into existing slots, or proposes new ones.',
      build: () =>
        norm(
          buildDataSlotAssignmentPrompt(
            SAMPLE_DATA_SLOT_STRUCTURE,
            [
              {
                key: 'slot_setup',
                name: 'Setup friction',
                theme: 'Onboarding',
                description: 'What made setup hard or smooth.',
                questionKeys: ['setup_ease', 'setup_blockers'],
              },
            ],
            ['needed_help']
          )
        ),
    }),
  ],
};

// ---------------------------------------------------------------------------
// Live conversation agents
// ---------------------------------------------------------------------------

const SELECTOR: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
  name: 'Question Selector',
  stage: 'live',
  summary:
    'Adaptive strategy only: picks which of the similarity-ranked candidate questions flows most naturally next. Sends a single plain-text prompt.',
  dispatch: 'Per turn when the version uses the adaptive selection strategy.',
  builderModule: 'app/api/v1/app/questionnaires/_lib/adaptive-deps.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'select.pick',
      label: 'Adaptive next-question pick',
      description:
        'A single plain-text prompt asking the model to choose the most natural next question.',
      build: () => [
        {
          role: 'user',
          content: buildSelectorPrompt({
            recentMessages: [
              'The setup itself was fine, but the docs were confusing.',
              'I almost gave up on the API keys step.',
            ],
            candidates: [
              { id: 'q1', key: 'setup_blockers', prompt: 'What got in the way during setup?' },
              { id: 'q2', key: 'needed_help', prompt: 'Did you need to contact support?' },
              { id: 'q3', key: 'setup_ease', prompt: 'How easy was setup overall?' },
            ],
            sessionId: 'sample-session',
          }),
        },
      ],
    }),
  ],
};

const ANSWER_EXTRACTOR: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  name: 'Answer Extractor',
  stage: 'live',
  summary:
    'The conversation’s workhorse: turns each respondent message into typed answers (and, when enabled, data-slot fills, a genuineness check, and a sensitivity assessment).',
  dispatch: 'Once per respondent turn, dispatched by the live turn loop.',
  builderModule: 'lib/app/questionnaire/extraction/extraction-prompt.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'extract-answer.question',
      label: 'Question mode',
      description:
        'The default per-turn extraction prompt when the respondent answers a fixed question.',
      conditions: ['Data Slots off', 'Sensitivity off'],
      build: () => norm(buildAnswerExtractionPrompt(answerCtx())),
    }),
    specimen({
      id: 'extract-answer.data-slots',
      label: 'Data-slot mode',
      description:
        'When the version runs on data slots — the extractor also fills slots in the same call.',
      conditions: ['Data Slots on'],
      build: () =>
        norm(
          buildAnswerExtractionPrompt({
            ...answerCtx(),
            activeQuestionKey: null,
            dataSlotCandidates: [
              {
                key: 'setup_friction',
                name: 'Setup friction',
                description: 'What made setup hard or smooth.',
                theme: 'Onboarding',
                mappedQuestionKeys: ['setup_ease', 'setup_blockers'],
              },
            ],
          })
        ),
    }),
    specimen({
      id: 'extract-answer.sensitivity',
      label: 'Sensitivity awareness on',
      description:
        'When safeguarding is enabled — an extra block asks the extractor to flag genuine sensitive disclosures.',
      conditions: ['Sensitivity awareness on'],
      build: () => norm(buildAnswerExtractionPrompt({ ...answerCtx(), sensitivityAware: true })),
    }),
    specimen({
      id: 'extract-answer.seriousness',
      label: 'Seriousness gate (stage 2)',
      description:
        'A separate structured call — run under this agent’s binding — that rules whether a flagged answer is a genuine attempt.',
      conditions: ['Seriousness gate on'],
      build: () => {
        const { system, user } = buildSeriousnessJudgePrompt({
          questionPrompt: 'What got in the way during setup?',
          userMessage: 'asdfasdf lol',
          recentMessages: ['Setup was fine I guess.'],
          sessionId: 'sample-session',
        });
        return [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ];
      },
    }),
  ],
};

/** Shared answer-extraction context (question mode). */
function answerCtx() {
  return {
    activeQuestionKey: 'setup_blockers',
    candidateSlots: [
      {
        key: 'setup_blockers',
        type: 'free_text' as const,
        typeConfig: null,
        prompt: 'What, if anything, got in the way during setup?',
        required: false,
      },
      {
        key: 'setup_ease',
        type: 'likert' as const,
        typeConfig: { min: 1, max: 5 },
        prompt: 'How easy was it to set up the product?',
        required: true,
      },
    ],
    answered: [{ slotKey: 'setup_ease', confidence: 0.8 }],
    userMessage: 'The docs were confusing — the API keys step nearly made me give up.',
    recentMessages: ['Setup itself was quick.'],
    sessionId: 'sample-session',
  };
}

const CONTRADICTION_DETECTOR: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  name: 'Contradiction Detector',
  stage: 'live',
  summary:
    'Compares captured answers across slots and reports genuine logical conflicts — optionally with a follow-up question to reconcile them.',
  dispatch: 'Per turn and at the completion sweep, when contradiction detection is enabled.',
  builderModule: 'lib/app/questionnaire/contradiction/detection-prompt.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'detect.probe',
      label: 'Probe mode',
      description: 'Compares answers and, on a conflict, proposes a follow-up to reconcile it.',
      build: () =>
        norm(
          buildContradictionDetectionPrompt({
            slots: [
              {
                key: 'setup_ease',
                type: 'likert',
                typeConfig: { min: 1, max: 5 },
                prompt: 'How easy was it to set up the product?',
                required: true,
              },
              {
                key: 'needed_help',
                type: 'boolean',
                typeConfig: null,
                prompt: 'Did you need to contact support?',
                required: false,
              },
            ],
            answers: [
              { slotKey: 'setup_ease', value: 5, confidence: 0.9, provenance: 'direct' },
              { slotKey: 'needed_help', value: true, confidence: 0.85, provenance: 'direct' },
            ],
            mode: 'probe',
            windowN: 0,
            sessionId: 'sample-session',
          })
        ),
    }),
  ],
};

const ANSWER_REFINER: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  name: 'Answer Refiner',
  stage: 'live',
  summary:
    'Decides whether an already-captured answer should change in light of new context (a clarifying message or a flagged contradiction).',
  dispatch: 'When a contradiction is reconciled or the respondent clarifies an earlier answer.',
  builderModule: 'lib/app/questionnaire/refinement/refinement-prompt.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'refine.triggered',
      label: 'Contradiction-triggered refinement',
      description:
        'Sent when a flagged contradiction (or a clarifying message) may justify updating an answer.',
      build: () =>
        norm(
          buildRefinementPrompt({
            slots: [
              {
                key: 'setup_ease',
                type: 'likert',
                typeConfig: { min: 1, max: 5 },
                prompt: 'How easy was it to set up the product?',
                required: true,
              },
            ],
            existingAnswers: [
              { slotKey: 'setup_ease', value: 5, provenance: 'direct', confidence: 0.9 },
            ],
            userMessage: 'Actually it was pretty rough — I’d say a 2, not a 5.',
            triggeringContradiction: {
              slotKeys: ['setup_ease'],
              explanation: 'Rated setup 5/5 but described nearly giving up.',
              suggestedProbe: 'Would you still rate setup that highly?',
            },
            recentMessages: ['The API keys step nearly made me quit.'],
            sessionId: 'sample-session',
          })
        ),
    }),
  ],
};

const INTERVIEWER: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  name: 'Interviewer',
  stage: 'live',
  summary:
    'Phrases the next question as warm, natural prose — acknowledging the prior answer and calibrating to the audience and (when enabled) the configured tone.',
  dispatch:
    'Per asked question when conversational phrasing is enabled; streamed to the respondent.',
  builderModule: 'app/api/v1/app/questionnaire-sessions/_lib/question-stream.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'interview.opening',
      label: 'Opening question',
      description: 'The first question of the conversation — no prior answer to acknowledge.',
      build: () =>
        norm(
          buildStreamingQuestionPrompt({
            prompt: 'How easy was it to set up the product?',
            type: 'likert',
            typeConfig: { min: 1, max: 5 },
            goal: 'Understand onboarding friction',
            audience: SAMPLE_AUDIENCE,
            recentMessages: [],
            lastUserMessage: '',
            isReask: false,
            isOpening: true,
            questionsAsked: 0,
          })
        ),
    }),
    specimen({
      id: 'interview.tone',
      label: 'Mid-conversation with tone',
      description:
        'A follow-up question with the interviewer tone settings applied (empathy + warmth here).',
      conditions: ['Tone on'],
      build: () =>
        norm(
          buildStreamingQuestionPrompt({
            prompt: 'What got in the way during setup?',
            type: 'free_text',
            goal: 'Understand onboarding friction',
            audience: SAMPLE_AUDIENCE,
            recentMessages: ['Setup was a bit of a struggle, honestly.'],
            lastUserMessage: 'Setup was a bit of a struggle, honestly.',
            isReask: false,
            isOpening: false,
            questionsAsked: 2,
            tone: {
              ...DEFAULT_TONE_SETTINGS,
              empathy: { enabled: true, level: 4 },
              warmth: { enabled: true, level: 4 },
            },
          })
        ),
    }),
  ],
};

const COMPLETION_AGENT: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
  name: 'Completion Agent',
  stage: 'live',
  summary:
    'Once the deterministic gate decides the respondent has answered enough, phrases the warm offer to wrap up — it never decides whether to offer.',
  dispatch:
    'At the completion offer, by the completion-status route (structured) and the live stream (prose).',
  builderModule: 'lib/app/questionnaire/completion/completion-prompt.ts',
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'complete.structured',
      label: 'Structured offer (preview)',
      description: 'The structured-JSON offer used by the admin preview route.',
      build: () => norm(buildCompletionOfferPrompt(completionInput())),
    }),
    specimen({
      id: 'complete.stream',
      label: 'Streamed offer (live)',
      description: 'The prose variant streamed token-by-token to a live respondent.',
      build: () => norm(buildStreamingOfferPrompt({ ...completionInput(), costWrapUp: false })),
    }),
  ],
};

/** Shared completion-offer input. */
function completionInput() {
  return {
    coverage: 0.78,
    answeredCount: 6,
    capReached: false,
    coveredSlots: [
      { key: 'setup_ease', prompt: 'How easy was it to set up the product?' },
      { key: 'setup_blockers', prompt: 'What got in the way during setup?' },
    ],
    remainingSlots: [{ key: 'needed_help', prompt: 'Did you need to contact support?' }],
    recentMessages: ['Thanks, that covers most of it.', 'The docs were the main pain point.'],
  };
}

// ---------------------------------------------------------------------------
// Evaluation judges — one agent per dimension, generated from the registry
// ---------------------------------------------------------------------------

const JUDGES: PromptAgentCatalogEntry[] = EVALUATION_DIMENSIONS.map((dimension) => {
  const spec = EVALUATION_DIMENSION_SPECS[dimension];
  return {
    slug: spec.slug,
    name: spec.label,
    stage: 'evaluation' as const,
    summary: spec.summary,
    dispatch: 'Once per design-evaluation run, when the judge panel scores a draft.',
    builderModule: 'lib/app/questionnaire/evaluation/judge-prompt.ts',
    instructionsAreLoadBearing: false,
    specimens: [
      specimen({
        id: `${spec.slug}.judge`,
        label: `Judge: ${dimension}`,
        description: `Scores the "${dimension}" dimension of a draft against its goal and audience, and proposes edits.`,
        build: () => norm(buildJudgePrompt(dimension, SAMPLE_VERSION_STRUCTURE)),
      }),
    ],
  };
});

// ---------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------

/**
 * Build the full prompt catalog — every questionnaire agent with the exact
 * prompt(s) it sends, rendered from representative sample contexts. Pure; the route
 * merges each agent's DB binding on top.
 */
export function buildPromptCatalog(): PromptAgentCatalogEntry[] {
  return [
    // Authoring
    STRUCTURE_EXTRACTOR,
    COMPOSER,
    DATA_SLOT_GENERATOR,
    // Live conversation
    SELECTOR,
    ANSWER_EXTRACTOR,
    INTERVIEWER,
    CONTRADICTION_DETECTOR,
    ANSWER_REFINER,
    COMPLETION_AGENT,
    // Evaluation
    ...JUDGES,
  ];
}
