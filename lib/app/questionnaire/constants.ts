/**
 * Dependency-light constants for the questionnaire app module.
 *
 * Kept runtime-import-free so leaf consumers (e.g. the flag seed) can reference a
 * value like the feature-flag name without pulling in the HTTP/DB-bearing helpers
 * in `feature-flag.ts`. The single type-only import below is erased at compile
 * time, so this stays runtime-dependency-free.
 */

import type { CapabilityFunctionDefinition } from '@/lib/orchestration/capabilities/types';

/**
 * Feature-flag name gating every questionnaire surface. DB-backed (seeded
 * disabled by `prisma/seeds/app-questionnaire/001-questionnaires-flag.ts`), so
 * it can be toggled at runtime without a redeploy. See `feature-flag.ts` for the
 * resolver and route gate.
 */
export const APP_QUESTIONNAIRES_FLAG = 'APP_QUESTIONNAIRES_ENABLED';

/**
 * Sub-flag gating the F4.1 **adaptive** selection strategy (LLM + pgvector).
 * Disabled by default: adaptive spends on embeddings + an LLM call per turn, so
 * an operator opts in deliberately. When off, the config editor hides the
 * `adaptive` option and any version persisted with `selectionStrategy: 'adaptive'`
 * degrades to `weighted` at run time. Independent of {@link APP_QUESTIONNAIRES_FLAG}
 * (the master gate); both must be on for adaptive to run. Seeded by
 * `prisma/seeds/app-questionnaire/004-adaptive-selection-flag.ts`.
 */
export const APP_QUESTIONNAIRES_ADAPTIVE_FLAG = 'APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED';

/**
 * Sub-flag gating F4.2 **answer extraction** (the per-turn LLM call that turns a
 * respondent's message into typed slot values). Disabled by default: every turn
 * spends an LLM call, so an operator opts in deliberately — the same reasoning as
 * the adaptive-selection sub-flag above. Independent of {@link APP_QUESTIONNAIRES_FLAG}
 * (the master gate); both must be on for the extract-answer route to run.
 * Seeded by `prisma/seeds/app-questionnaire/008-answer-extraction-flag.ts`.
 */
export const APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG =
  'APP_QUESTIONNAIRES_ANSWER_EXTRACTION_ENABLED';

/**
 * Slug of the seeded selection `AiAgent` (F4.1 / adaptive). Drives the "which of
 * these candidate questions flows most naturally?" pick via `drainStreamChat`,
 * the same way the evaluation judges are driven. Ships with empty `model`/
 * `provider` so it resolves dynamically via `agent-resolver.ts`. App-prefixed to
 * avoid collision with core system agents.
 */
export const QUESTIONNAIRE_SELECTOR_AGENT_SLUG = 'app-questionnaire-selector';

/**
 * Width of the `AppQuestionSlot.embedding` pgvector column — must match the
 * platform embedding model (the knowledge subsystem standardises on 1536). The
 * migration hard-codes it in DDL; this constant is the single reference for the
 * embedding/search code so a column-width change has one obvious touch-point.
 */
export const QUESTIONNAIRE_EMBEDDING_DIMENSION = 1536;

/**
 * Slug of the extractor capability (F1.1 / PR3). One source of truth shared by
 * the `BaseCapability` subclass, its `AiCapability` seed row, and the ingestion
 * route (PR4) that dispatches it. Snake_case to match the built-in capability
 * convention (`call_external_api`, `apply_audit_changes`); the `app_` prefix
 * marks it as fork-owned.
 */
export const EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG =
  'app_extract_questionnaire_structure';

/**
 * `AiCapability.executionHandler` value for the extractor capability — the class
 * name the dispatcher resolves the in-memory handler by. Must match the class
 * registered in `lib/app/capabilities.ts`.
 */
export const EXTRACT_QUESTIONNAIRE_STRUCTURE_HANDLER = 'AppExtractQuestionnaireStructureCapability';

/**
 * Slug of the seeded extractor `AiAgent` (F1.1 / PR3). Ships with empty
 * `model`/`provider` so it resolves dynamically via `agent-resolver.ts`; the
 * ingestion route (PR4) loads it to populate the dispatch context. App-prefixed
 * to avoid collision with core system agents (`quiz-master`, `model-auditor`).
 */
export const QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG = 'app-questionnaire-extractor';

/**
 * The extractor capability's OpenAI-compatible function definition — the single
 * source of truth shared by the `BaseCapability` subclass (its `functionDefinition`
 * field) and the `AiCapability` seed row (003), so the two can never drift. Lives
 * here (rather than on the class) so the seed can import it without pulling the
 * capability's orchestration dependency graph into the seed runtime.
 */
export const EXTRACT_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  description:
    'Extract an opinionated, structured questionnaire (sections, questions with inferred types, an inferred goal/audience, and a per-decision editorial change log) from parsed document text. Dispatched programmatically by the ingestion route — not exposed to a chat tool loop.',
  parameters: {
    type: 'object',
    properties: {
      documentText: {
        type: 'string',
        description: 'Plain text extracted from the uploaded questionnaire document.',
      },
      fileName: {
        type: 'string',
        description: 'Original file name of the upload (for provenance and prompt context).',
      },
      mediaType: {
        type: 'string',
        description: 'Optional MIME type of the upload.',
      },
      adminProvidedGoal: {
        type: 'string',
        description:
          'Goal the admin set on upload. When present, the extractor must NOT infer the goal.',
      },
      adminProvidedAudience: {
        type: 'object',
        description:
          'Audience fields the admin set on upload. Inference is suppressed per supplied field.',
        additionalProperties: true,
      },
    },
    required: ['documentText', 'fileName'],
  },
};

/**
 * Slug of the answer-extractor capability (F4.2). One source of truth shared by
 * the `BaseCapability` subclass, its `AiCapability` seed row, and the preview
 * route that dispatches it. Same naming convention as the structure extractor
 * above — snake_case with the fork-owned `app_` prefix.
 */
export const EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG = 'app_extract_answer_slots';

/**
 * `AiCapability.executionHandler` value for the answer-extractor capability — the
 * class name the dispatcher resolves the in-memory handler by. Must match the
 * class registered in `lib/app/capabilities.ts`.
 */
export const EXTRACT_ANSWER_SLOTS_HANDLER = 'AppExtractAnswerSlotsCapability';

/**
 * Slug of the seeded answer-extractor `AiAgent` (F4.2). A distinct agent from the
 * document-structure extractor and the selection agent: answer extraction runs
 * once per respondent turn (far higher volume than one-off ingestion), so it
 * carries its own budget ceiling and persona. Ships with empty `model`/`provider`
 * so it resolves dynamically via `agent-resolver.ts`; the preview route loads it
 * to populate the dispatch context. App-prefixed to avoid collision with core
 * system agents.
 */
export const QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG = 'app-questionnaire-answer-extractor';

/**
 * The answer-extractor capability's OpenAI-compatible function definition — the
 * single source of truth shared by the `BaseCapability` subclass and the
 * `AiCapability` seed row, so the two can never drift. Lives here (rather than on
 * the class) so the seed can import it without pulling the capability's
 * orchestration dependency graph into the seed runtime. Dispatched
 * programmatically by the preview route — not exposed to a chat tool loop.
 */
export const EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  description:
    "Extract typed answer values from a respondent's message for one or more question slots — the active question plus any others the message also answers (side-effects). Returns per-slot intents with value, confidence, provenance, and rationale. Dispatched programmatically by the preview route; persists nothing.",
  parameters: {
    type: 'object',
    properties: {
      userMessage: {
        type: 'string',
        description: "The respondent's message to extract answers from (this turn).",
      },
      activeQuestionKey: {
        type: 'string',
        description: 'Key of the question currently being asked (must be one of candidateSlots).',
      },
      candidateSlots: {
        type: 'array',
        description:
          'Slots a value may be extracted into this turn — the active slot plus unanswered slots.',
        items: { type: 'object', additionalProperties: true },
      },
      answered: {
        type: 'array',
        description: 'Slots already answered this session (so the extractor does not re-ask).',
        items: { type: 'object', additionalProperties: true },
      },
      recentMessages: {
        type: 'array',
        description: 'Recent transcript, oldest first, for disambiguation.',
        items: { type: 'string' },
      },
      sessionId: {
        type: 'string',
        description: 'Stable session identity, threaded into cost-log metadata.',
      },
    },
    required: ['userMessage', 'activeQuestionKey', 'candidateSlots'],
  },
};

/**
 * Sub-flag gating F4.3 **contradiction detection** (the LLM call that compares a
 * respondent's answers across slots and surfaces logical conflicts). Disabled by
 * default: it spends an LLM call per detection pass, so an operator opts in
 * deliberately — the same reasoning as the answer-extraction sub-flag above.
 * Independent of {@link APP_QUESTIONNAIRES_FLAG} (the master gate); both must be on
 * for the detect-contradictions route to run. Seeded by
 * `prisma/seeds/app-questionnaire/011-contradiction-detection-flag.ts`.
 */
export const APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG =
  'APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_ENABLED';

/**
 * Slug of the contradiction-detector capability (F4.3). One source of truth shared
 * by the `BaseCapability` subclass, its `AiCapability` seed row, and the preview
 * route that dispatches it. Same naming convention as the extractors above —
 * snake_case with the fork-owned `app_` prefix.
 */
export const DETECT_CONTRADICTIONS_CAPABILITY_SLUG = 'app_detect_contradictions';

/**
 * `AiCapability.executionHandler` value for the contradiction-detector capability —
 * the class name the dispatcher resolves the in-memory handler by. Must match the
 * class registered in `lib/app/capabilities.ts`.
 */
export const DETECT_CONTRADICTIONS_HANDLER = 'AppDetectContradictionsCapability';

/**
 * Slug of the seeded contradiction-detector `AiAgent` (F4.3). A distinct agent from
 * the answer extractor: detection runs on its own cadence (per turn and/or at the
 * completion sweep) and carries its own budget ceiling and persona. Ships with
 * empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts`; the
 * preview route loads it to populate the dispatch context. App-prefixed to avoid
 * collision with core system agents.
 */
export const QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG =
  'app-questionnaire-contradiction-detector';

/**
 * The contradiction-detector capability's OpenAI-compatible function definition —
 * the single source of truth shared by the `BaseCapability` subclass and the
 * `AiCapability` seed row, so the two can never drift. Lives here (rather than on
 * the class) so the seed can import it without pulling the capability's
 * orchestration dependency graph into the seed runtime. Dispatched programmatically
 * by the preview route — not exposed to a chat tool loop.
 */
export const DETECT_CONTRADICTIONS_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  description:
    "Compare a respondent's captured answers across question slots and report genuine logical contradictions (which slots conflict, why, a severity, and — under probe mode — a follow-up question to reconcile them). Surfaces conflicts for confirmation; never overwrites an answer. Dispatched programmatically by the preview route; persists nothing.",
  parameters: {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        description: 'The version slot definitions (key, type, prompt, typeConfig) to reason over.',
        items: { type: 'object', additionalProperties: true },
      },
      answers: {
        type: 'array',
        description:
          'The captured answers to compare — each { slotKey, value, confidence?, provenance? }.',
        items: { type: 'object', additionalProperties: true },
      },
      mode: {
        type: 'string',
        description: 'Behaviour on a hit: off | flag (surface) | probe (request a follow-up).',
      },
      windowN: {
        type: 'number',
        description: 'How many prior answers to compare against; 0 = compare all.',
      },
      sessionId: {
        type: 'string',
        description: 'Stable session identity, threaded into cost-log metadata.',
      },
    },
    required: ['slots', 'answers', 'mode'],
  },
};

/**
 * Sub-flag gating F4.4 **answer refinement** (the LLM call that decides whether a
 * respondent's already-captured answer should be updated in light of new context).
 * Disabled by default: it spends an LLM call per refinement pass, so an operator
 * opts in deliberately — the same reasoning as the contradiction-detection sub-flag
 * above. Independent of {@link APP_QUESTIONNAIRES_FLAG} (the master gate); both must
 * be on for the refine-answer route to run. Seeded by
 * `prisma/seeds/app-questionnaire/014-answer-refinement-flag.ts`.
 */
export const APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG =
  'APP_QUESTIONNAIRES_ANSWER_REFINEMENT_ENABLED';

/**
 * Slug of the answer-refiner capability (F4.4). One source of truth shared by the
 * `BaseCapability` subclass, its `AiCapability` seed row, and the refine-answer route
 * that dispatches it. Same naming convention as the extractors/detector above —
 * snake_case with the fork-owned `app_` prefix.
 */
export const REFINE_ANSWER_CAPABILITY_SLUG = 'app_refine_answer';

/**
 * `AiCapability.executionHandler` value for the answer-refiner capability — the class
 * name the dispatcher resolves the in-memory handler by. Must match the class
 * registered in `lib/app/capabilities.ts`.
 */
export const REFINE_ANSWER_HANDLER = 'AppRefineAnswerCapability';

/**
 * Slug of the seeded answer-refiner `AiAgent` (F4.4). A distinct agent from the
 * answer extractor and contradiction detector: refinement runs on its own cadence
 * (when a contradiction is reconciled or a respondent clarifies an earlier answer)
 * and carries its own budget ceiling and persona. Ships with empty `model`/`provider`
 * so it resolves dynamically via `agent-resolver.ts`; the refine-answer route loads
 * it to populate the dispatch context. App-prefixed to avoid collision with core
 * system agents.
 */
export const QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG = 'app-questionnaire-answer-refiner';

/**
 * The answer-refiner capability's OpenAI-compatible function definition — the single
 * source of truth shared by the `BaseCapability` subclass and the `AiCapability` seed
 * row, so the two can never drift. Lives here (rather than on the class) so the seed
 * can import it without pulling the capability's orchestration dependency graph into
 * the seed runtime. Dispatched programmatically by the refine-answer route — not
 * exposed to a chat tool loop.
 */
export const REFINE_ANSWER_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: REFINE_ANSWER_CAPABILITY_SLUG,
  description:
    "Decide whether each of a respondent's already-captured answers should be updated in light of new context (a clarifying message and/or a flagged contradiction). Returns per-slot decisions — refine (the value evolved), overwrite (a mistaken capture), or leave — with the new value and a rationale. Dispatched programmatically by the refine-answer route.",
  parameters: {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        description: 'The version slot definitions (key, type, prompt, typeConfig) to reason over.',
        items: { type: 'object', additionalProperties: true },
      },
      existingAnswers: {
        type: 'array',
        description:
          'The already-captured answers eligible for refinement — each { slotKey, value, provenance, rationale?, confidence? }.',
        items: { type: 'object', additionalProperties: true },
      },
      userMessage: {
        type: 'string',
        description: "The respondent's new message that may warrant a refinement (optional).",
      },
      triggeringContradiction: {
        type: 'object',
        description:
          'The F4.3 contradiction finding that triggered this pass (slotKeys, explanation, suggestedProbe) — the detection→refinement handoff (optional).',
        additionalProperties: true,
      },
      sessionId: {
        type: 'string',
        description: 'Stable session identity, threaded into cost-log metadata.',
      },
    },
    required: ['slots', 'existingAnswers'],
  },
};
