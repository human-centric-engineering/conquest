/**
 * Prompt catalog — the single source of truth for the admin "Prompt Library".
 *
 * WHY THIS EXISTS. Most questionnaire agents are dispatched *programmatically*: the
 * load-bearing system prompt is assembled in a TypeScript builder (e.g.
 * `buildAnswerExtractionPrompt`), NOT read from the agent's editable
 * `AiAgent.systemInstructions` field (which is descriptive only — see each agent
 * seed's header comment). That makes the real prompts invisible to an operator
 * reading the admin agent form. This catalog closes that gap: it invokes each real
 * builder with PLACEHOLDER inputs (`{{ … }}` tokens, filled at run time with the real
 * questionnaire + transcript) and returns the exact messages we would send the model,
 * so an admin can read the prompt *shape* we actually use.
 *
 * The **Question Selector** is the exception: it runs through `streamChat`, so its
 * SYSTEM prompt *is* the editable `systemInstructions` field (load-bearing — editing
 * it changes selection), and only its per-turn USER message is code-built here. Its
 * `instructionsAreLoadBearing` is therefore `true`.
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
  buildComposeOutlinePrompt,
  buildComposeSectionQuestionsPrompt,
  buildRefineStructurePrompt,
} from '@/lib/app/questionnaire/ingestion/compose-prompt';
import { buildAnswerExtractionPrompt } from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { buildContradictionDetectionPrompt } from '@/lib/app/questionnaire/contradiction/detection-prompt';
import { buildRefinementPrompt } from '@/lib/app/questionnaire/refinement/refinement-prompt';
import { buildCompletionOfferPrompt } from '@/lib/app/questionnaire/completion/completion-prompt';
import { buildSeriousnessJudgePrompt } from '@/lib/app/questionnaire/seriousness/judge-prompt';
import { buildSensitivityDetectPrompt } from '@/lib/app/questionnaire/sensitivity';
import {
  buildDataSlotGenerationPrompt,
  buildDataSlotRefinementPrompt,
  buildDataSlotAssignmentPrompt,
} from '@/lib/app/questionnaire/data-slots/generation';
import { buildJudgePrompt } from '@/lib/app/questionnaire/evaluation/judge-prompt';
import { buildTurnEvaluatorPrompt } from '@/lib/app/questionnaire/turn-evaluation/prompt';
import type { TurnEvaluationInput } from '@/lib/app/questionnaire/turn-evaluation/types';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { DEFAULT_PERSONA_KEY, DEFAULT_TONE_SETTINGS } from '@/lib/app/questionnaire/types';
import { BUILT_IN_PERSONAS } from '@/lib/app/questionnaire/persona/presets';
import {
  EVALUATION_DIMENSIONS,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation/types';

import {
  buildStreamingQuestionPrompt,
  type QuestionComposeInput,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
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
  TURN_EVALUATOR_AGENT_SLUG,
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
   * Whether the agent's editable `systemInstructions` field drives the prompt.
   * `false` for the capability-dispatched agents (their whole prompt is assembled in
   * code, so the stored field is descriptive only). `true` for the `streamChat`-
   * dispatched Question Selector, whose system prompt *is* that field — editing it
   * changes behaviour. Surfaced so the admin knows which agents they can tune by hand.
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
// Shared sample fixtures.
//
// These are deliberately PLACEHOLDERS, not realistic example content: the values
// you see (`{{ questionnaire goal }}`, `{{ question 1 }}`, …) are template tokens
// that, at run time, are filled with YOUR questionnaire's goal, questions, and the
// live respondent transcript. The library renders these so an admin can read the
// prompt *structure* — the tokens make clear it is a shape, not real data.
// ---------------------------------------------------------------------------

const SAMPLE_AUDIENCE = {
  role: '{{ target audience }}',
  expertiseLevel: 'intermediate' as const,
  locale: 'en-GB',
  sensitivity: 'low' as const,
};

const SAMPLE_VERSION_STRUCTURE: VersionStructureInput = {
  goal: '{{ questionnaire goal }}',
  audience: SAMPLE_AUDIENCE,
  sections: [
    {
      title: '{{ section 1 title }}',
      description: '{{ section 1 description }}',
      questions: [
        {
          key: 'q1',
          prompt: '{{ question 1 }}',
          type: 'likert',
          required: true,
          guidelines: '{{ what a good answer looks like }}',
        },
        {
          key: 'q2',
          prompt: '{{ question 2 }}',
          type: 'free_text',
          required: false,
        },
      ],
    },
    {
      title: '{{ section 2 title }}',
      questions: [
        {
          key: 'q3',
          prompt: '{{ question 3 }}',
          type: 'boolean',
          required: false,
        },
      ],
    },
  ],
};

const SAMPLE_DATA_SLOT_STRUCTURE = {
  goal: '{{ questionnaire goal }}',
  questions: [
    { key: 'q1', prompt: '{{ question 1 }}', type: 'likert' },
    { key: 'q2', prompt: '{{ question 2 }}', type: 'free_text' },
    { key: 'q3', prompt: '{{ question 3 }}', type: 'boolean' },
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
              '{{ text extracted from the uploaded document — its questions, sections, and instructions }}',
            fileName: '{{ uploaded-file.pdf }}',
            mediaType: 'application/pdf',
            adminSupplied: {
              goal: '{{ admin-supplied goal, if any }}',
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
      id: 'compose.outline',
      label: 'Compose outline (streaming · phase 1)',
      description:
        'Phase 1 of streaming composition: plan the questionnaire SHAPE only — an inferred goal/audience and a section outline, with no questions written yet.',
      build: () =>
        norm(
          buildComposeOutlinePrompt(
            '{{ the admin plain-English brief describing the questionnaire to build }}',
            { goal: '{{ admin-supplied goal, if any }}', audience: SAMPLE_AUDIENCE }
          )
        ),
    }),
    specimen({
      id: 'compose.sections',
      label: 'Draft section questions (streaming · phase 2)',
      description:
        'Phase 2 of streaming composition: write the questions for ONE section, fanned out per section in parallel so a long questionnaire composes as fast as a short one.',
      build: () =>
        norm(
          buildComposeSectionQuestionsPrompt(
            '{{ the admin plain-English brief describing the questionnaire to build }}',
            {
              ordinal: 0,
              title: '{{ section 1 title }}',
              description: '{{ section 1 description }}',
              siblingTitles: ['{{ section 1 title }}', '{{ section 2 title }}'],
              goal: '{{ questionnaire goal }}',
            }
          )
        ),
    }),
    specimen({
      id: 'compose.full',
      label: 'Compose from brief (single-shot)',
      description:
        'The single-shot, API-accessible composition capability: the whole questionnaire — sections and all their questions — in one call.',
      build: () =>
        norm(
          buildComposeFullPrompt(
            '{{ the admin plain-English brief describing the questionnaire to build }}',
            { goal: '{{ admin-supplied goal, if any }}', audience: SAMPLE_AUDIENCE }
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
                {
                  ordinal: 0,
                  title: '{{ section 1 title }}',
                  description: '{{ section 1 description }}',
                },
              ],
              questions: [
                {
                  sectionOrdinal: 0,
                  key: 'q1',
                  prompt: '{{ question 1 }}',
                  suggestedType: 'likert',
                  extractionConfidence: 0.9,
                },
              ],
              inferredGoal: '{{ questionnaire goal }}',
              inferredAudience: SAMPLE_AUDIENCE,
            },
            '{{ the admin refinement instruction, e.g. add a section on pricing }}'
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
              name: '{{ data slot name }}',
              description: '{{ what this slot captures }}',
              theme: '{{ theme }}',
              questionKeys: ['q1', 'q2'],
            },
            '{{ the admin instruction for refining this slot }}',
            [{ name: '{{ another slot name }}', theme: '{{ theme }}' }]
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
                key: 'slot_1',
                name: '{{ data slot name }}',
                theme: '{{ theme }}',
                description: '{{ what this slot captures }}',
                questionKeys: ['q1', 'q2'],
              },
            ],
            ['q3']
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
    'Adaptive strategy only: picks which of the similarity-ranked candidate questions flows most naturally next. Its system prompt is the editable instructions; this per-turn user message carries the goal, transcript, answered set, and candidates.',
  dispatch: 'Per turn when the version uses the adaptive selection strategy.',
  builderModule: 'app/api/v1/app/questionnaires/_lib/adaptive-deps.ts',
  instructionsAreLoadBearing: true,
  specimens: [
    specimen({
      id: 'select.pick',
      label: 'Adaptive next-question pick',
      description:
        "The per-turn user message: the goal, recent transcript, already-answered questions, and the candidate list (each with its guidelines/rationale). The agent's editable system instructions ride above this.",
      build: () => [
        {
          role: 'user',
          content: buildSelectorPrompt({
            goal: '{{ questionnaire goal }}',
            recentMessages: [
              '{{ an earlier message in the conversation }}',
              '{{ the respondent most recent message }}',
            ],
            answeredQuestions: ['{{ a question already answered }}'],
            candidates: [
              {
                id: 'q1',
                key: 'q1',
                prompt: '{{ candidate question 1 }}',
                guidelines: '{{ what a good answer looks like }}',
              },
              { id: 'q2', key: 'q2', prompt: '{{ candidate question 2 }}' },
              {
                id: 'q3',
                key: 'q3',
                prompt: '{{ candidate question 3 }}',
                rationale: '{{ why this question matters }}',
              },
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
                key: 'slot_1',
                name: '{{ data slot name }}',
                description: '{{ what this slot captures }}',
                theme: '{{ theme }}',
                mappedQuestionKeys: ['q1', 'q2'],
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
      id: 'extract-answer.sensitivity-detector',
      label: 'Sensitivity detector (dedicated safeguarding call)',
      description:
        'A separate single-purpose structured call — run under this agent’s binding on every answered turn while safeguarding is on — that rules whether THIS message carries a genuine sensitive disclosure. It backs up the extractor’s optional field and a deterministic keyword floor (defence-in-depth), so a miss by one source is caught by another.',
      conditions: ['Sensitivity awareness on'],
      build: () => {
        const { system, user } = buildSensitivityDetectPrompt({
          questionPrompt: '{{ the question the respondent was asked }}',
          userMessage: '{{ the respondent message to rule on for a sensitive disclosure }}',
          recentMessages: ['{{ an earlier message }}'],
          sessionId: 'sample-session',
        });
        return [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ];
      },
    }),
    specimen({
      id: 'extract-answer.force-fit',
      label: 'Answer-fit resolver (force-fit pass)',
      description:
        'When `answerFitMode` is `fallback` or `always`, a second pass — run under this agent’s binding with a force-fit framing — maps free-text that failed deterministic per-type validation onto the closest allowed choice/scale option. The deterministic validation is the floor; this LLM pass only resolves what it could not.',
      conditions: ['Answer fit mode: fallback / always'],
      build: () => norm(buildAnswerExtractionPrompt({ ...answerCtx(), forceFit: true })),
    }),
    specimen({
      id: 'extract-answer.seriousness',
      label: 'Seriousness gate (stage 2)',
      description:
        'A separate structured call — run under this agent’s binding — that rules whether a flagged answer is a genuine attempt.',
      conditions: ['Seriousness gate on'],
      build: () => {
        const { system, user } = buildSeriousnessJudgePrompt({
          questionPrompt: '{{ the question the respondent was asked }}',
          userMessage: '{{ the respondent answer to judge for genuineness }}',
          recentMessages: ['{{ an earlier message }}'],
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
    activeQuestionKey: 'q2',
    candidateSlots: [
      {
        key: 'q2',
        type: 'free_text' as const,
        typeConfig: null,
        prompt: '{{ the active (free-text) question }}',
        required: false,
      },
      {
        key: 'q1',
        type: 'likert' as const,
        typeConfig: { min: 1, max: 5 },
        prompt: '{{ another (likert) question }}',
        required: true,
      },
    ],
    answered: [{ slotKey: 'q1', confidence: 0.8 }],
    userMessage: '{{ the respondent message to extract answers from }}',
    recentMessages: ['{{ an earlier message }}'],
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
                key: 'q1',
                type: 'likert',
                typeConfig: { min: 1, max: 5 },
                prompt: '{{ a likert question }}',
                required: true,
              },
              {
                key: 'q3',
                type: 'boolean',
                typeConfig: null,
                prompt: '{{ a yes/no question }}',
                required: false,
              },
            ],
            answers: [
              { slotKey: 'q1', value: 5, confidence: 0.9, provenance: 'direct' },
              { slotKey: 'q3', value: true, confidence: 0.85, provenance: 'direct' },
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
                key: 'q1',
                type: 'likert',
                typeConfig: { min: 1, max: 5 },
                prompt: '{{ a likert question }}',
                required: true,
              },
            ],
            existingAnswers: [{ slotKey: 'q1', value: 5, provenance: 'direct', confidence: 0.9 }],
            userMessage: '{{ the respondent clarifying message }}',
            triggeringContradiction: {
              slotKeys: ['q1'],
              explanation: '{{ why the captured answer may now be wrong }}',
              suggestedProbe: '{{ a follow-up question to reconcile the conflict }}',
            },
            recentMessages: ['{{ an earlier message }}'],
            sessionId: 'sample-session',
          })
        ),
    }),
  ],
};

/** The default built-in persona (The Coach), used to render the persona-mode interviewer specimen. */
const DEFAULT_INTERVIEWER_PERSONA =
  BUILT_IN_PERSONAS.find((p) => p.key === DEFAULT_PERSONA_KEY) ?? BUILT_IN_PERSONAS[0];

/**
 * Shared mid-conversation interviewer context (a normal acknowledge-and-ask turn). Both the custom-
 * tone and built-in-persona specimens spread this and layer their `tone` on top, so the two variants
 * differ only in the voice block — exactly as they do at run time (a persona is resolved into `tone`).
 */
function interviewFollowUpBase(): QuestionComposeInput {
  return {
    prompt: '{{ the next question to ask, in raw form }}',
    type: 'free_text',
    goal: '{{ questionnaire goal }}',
    audience: SAMPLE_AUDIENCE,
    recentMessages: ['{{ the respondent last message }}'],
    lastUserMessage: '{{ the respondent last message }}',
    priorAnswers: [
      '{{ data slot 1 name }}: {{ what they shared about it }}',
      '{{ data slot 2 name }}: {{ what they shared about it }}',
    ],
    isReask: false,
    isOpening: false,
    questionsAsked: 2,
  };
}

const INTERVIEWER: PromptAgentCatalogEntry = {
  slug: QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  name: 'Interviewer',
  stage: 'live',
  summary:
    'Phrases the next question as warm, natural prose — acknowledging the prior answer and calibrating to the audience and, when enabled, the configured tone or a chosen built-in persona (both flow through the same tone block).',
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
            prompt: '{{ the question to ask, in raw form }}',
            type: 'likert',
            typeConfig: { min: 1, max: 5 },
            goal: '{{ questionnaire goal }}',
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
        'A follow-up question with a custom interviewer tone applied (empathy + warmth here).',
      conditions: ['Custom tone on'],
      build: () =>
        norm(
          buildStreamingQuestionPrompt({
            ...interviewFollowUpBase(),
            tone: {
              ...DEFAULT_TONE_SETTINGS,
              empathy: { enabled: true, level: 4 },
              warmth: { enabled: true, level: 4 },
            },
          })
        ),
    }),
    specimen({
      id: 'interview.persona',
      label: 'Built-in persona',
      description:
        'When respondent persona mode is on, the chosen (or default) library persona replaces the version tone — injecting an “Adopt this persona…” clause plus its tuned dials into the same tone block. Rendered here with the default persona, The Coach.',
      conditions: ['Persona mode on'],
      build: () =>
        norm(
          buildStreamingQuestionPrompt({
            ...interviewFollowUpBase(),
            tone: DEFAULT_INTERVIEWER_PERSONA.tone,
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
      { key: 'q1', prompt: '{{ an answered question }}' },
      { key: 'q2', prompt: '{{ another answered question }}' },
    ],
    remainingSlots: [{ key: 'q3', prompt: '{{ an optional remaining question }}' }],
    recentMessages: ['{{ a recent respondent message }}', '{{ another recent message }}'],
  };
}

// ---------------------------------------------------------------------------
// Turn evaluator — the interview-quality judge the Preview Turn Inspector runs
// ---------------------------------------------------------------------------

/** A representative one-turn inspector dump + objectives the evaluator judges. */
const SAMPLE_TURN_EVAL_INPUT: TurnEvaluationInput = {
  turn: {
    turnIndex: 3,
    calls: [
      {
        label: 'Answer extraction',
        model: '{{ model }}',
        provider: '{{ provider }}',
        latencyMs: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        prompt: [
          { role: 'system', content: '{{ the extractor system prompt }}' },
          { role: 'user', content: '{{ the respondent message + candidate slots }}' },
        ],
        response: '{{ the extracted typed answers (JSON) }}',
      },
      {
        kind: 'embedding',
        label: 'Adaptive data-slot ranking',
        model: '{{ embedding model }}',
        provider: '{{ provider }}',
        latencyMs: 0,
        costUsd: 0,
        tokensIn: 0,
        dimensions: 1536,
        prompt: [{ role: 'input', content: 'Embedded (query): "{{ respondent message }}"' }],
        response: '{{ ranking summary, e.g. "Ranked 62 → kept 8 slots" }}',
      },
    ],
  },
  context: {
    goal: '{{ questionnaire goal }}',
    audience: '{{ target audience }}',
    selectionStrategy: 'adaptive',
    tone: '{{ configured interviewer tone }}',
    respondentMessage: '{{ the respondent answer that opened this turn }}',
    interviewerMessage: '{{ the interviewer reply that closed this turn }}',
    recentMessages: ['{{ a recent respondent message }}', '{{ a recent interviewer message }}'],
  },
};

const TURN_EVALUATOR: PromptAgentCatalogEntry = {
  slug: TURN_EVALUATOR_AGENT_SLUG,
  name: 'Turn evaluator',
  stage: 'evaluation',
  summary:
    'Judges ONE completed interview turn from the Preview Turn Inspector — instruction adherence, interviewing/extraction/selection quality, information gain, prompt drift, and cost/efficiency.',
  dispatch: 'On demand from the inspector drawer, once per turn an admin chooses to evaluate.',
  builderModule: 'lib/app/questionnaire/turn-evaluation/prompt.ts',
  // The rubric is code-defined (`SYSTEM_RUBRIC` in the builder), NOT the agent's editable
  // `systemInstructions` — evaluate-turn.ts dispatches via `buildTurnEvaluatorPrompt`, the same
  // in-code split the design-evaluation judges use. Only the streamChat selector is load-bearing.
  instructionsAreLoadBearing: false,
  specimens: [
    specimen({
      id: 'turn-eval.judge',
      label: 'Judge a turn',
      description:
        'The load-bearing rubric plus the serialized turn dump the evaluator scores — here one LLM extraction call and one embedding (VEC) ranking call, alongside the questionnaire objectives.',
      build: () => norm(buildTurnEvaluatorPrompt(SAMPLE_TURN_EVAL_INPUT)),
    }),
  ],
};

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
 * Build the prompt catalog — the questionnaire agents across the core authoring → live → evaluation
 * lifecycle, each with the exact prompt(s) it sends, rendered from representative sample contexts.
 * Post-completion and support agents (report formatter, respondent/cohort report, advisor, structure
 * editor) are out of scope here. Pure; the route merges each agent's DB binding on top.
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
    TURN_EVALUATOR,
    ...JUDGES,
  ];
}
