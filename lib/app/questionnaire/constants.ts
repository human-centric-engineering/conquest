/**
 * Dependency-light constants for the questionnaire app module.
 *
 * Kept runtime-import-free so leaf consumers (e.g. seeds) can reference values
 * without pulling in HTTP/DB-bearing helpers. The single type-only import below
 * is erased at compile time, so this stays runtime-dependency-free.
 */

import type { CapabilityFunctionDefinition } from '@/lib/orchestration/capabilities/types';

/**
 * Upper bound (characters) on the admin-supplied free-text extraction
 * instructions attached to an upload/re-ingest. The single source of truth,
 * shared by the multipart boundary parser (`upload-input.ts`, which throws a 400
 * over-cap) and the extractor capability's Zod `argsSchema` — kept here so the
 * two caps can never drift. Generous enough for a paragraph or two of steering,
 * bounded so a pasted essay can't crowd the document out of the prompt.
 */
export const MAX_INSTRUCTIONS_LENGTH = 4_000;

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
      adminProvidedInstructions: {
        type: 'string',
        description:
          'Free-text steering for the extraction (which tab holds the questions, a term to genericise, etc.). Guidance only — does NOT suppress goal/audience inference.',
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
        description:
          'Key of the question currently being asked (must be one of candidateSlots). Omitted in ' +
          'data-slot mode, where the respondent answers an open prompt with no single active question.',
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
    required: ['userMessage', 'candidateSlots'],
  },
};

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
      currentStatement: {
        type: 'string',
        description:
          "The respondent's latest message, when the detector should also weigh it against the captured answers (catches a same-slot reversal). When present, a finding may reference a single conflicting slot.",
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

/**
 * Slug of the completion-offer composer capability (F4.5). One source of truth shared
 * by the `BaseCapability` subclass, its `AiCapability` seed row, and the
 * completion-status route that dispatches it. Same naming convention as the
 * extractors/detector/refiner above — snake_case with the fork-owned `app_` prefix.
 */
export const COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG = 'app_compose_completion_offer';

/**
 * `AiCapability.executionHandler` value for the completion-offer composer — the class
 * name the dispatcher resolves the in-memory handler by. Must match the class
 * registered in `lib/app/capabilities.ts`.
 */
export const COMPOSE_COMPLETION_OFFER_HANDLER = 'AppComposeCompletionOfferCapability';

/**
 * Slug of the seeded completion `AiAgent` (F4.5). A distinct agent from the others:
 * it phrases the wrap-up offer (a warm, conversational close) rather than extracting
 * or judging, so it carries its own persona and budget ceiling. Ships with empty
 * `model`/`provider` so it resolves dynamically via `agent-resolver.ts`; the
 * completion-status route loads it to populate the dispatch context. App-prefixed to
 * avoid collision with core system agents.
 */
export const QUESTIONNAIRE_COMPLETION_AGENT_SLUG = 'app-questionnaire-completion-agent';

/**
 * The completion-offer composer's OpenAI-compatible function definition — the single
 * source of truth shared by the `BaseCapability` subclass and the `AiCapability` seed
 * row, so the two can never drift. Lives here (rather than on the class) so the seed
 * can import it without pulling the capability's orchestration dependency graph into
 * the seed runtime. Dispatched programmatically by the completion-status route — not
 * exposed to a chat tool loop.
 */
export const COMPOSE_COMPLETION_OFFER_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  description:
    'Compose the natural-language offer to submit a conversational questionnaire, once the system has already determined the respondent has answered enough. Returns a warm offer message, a short recap of what was covered, and an optional note on what remains optional. Phrasing only — it never decides whether to offer (that is deterministic). Dispatched programmatically by the completion-status route; persists nothing.',
  parameters: {
    type: 'object',
    properties: {
      coverage: {
        type: 'number',
        description: 'Weighted coverage in [0, 1] at offer time.',
      },
      answeredCount: {
        type: 'number',
        description: 'Distinct questions answered this session.',
      },
      capReached: {
        type: 'boolean',
        description: 'Whether the per-session cap forced the offer (vs. thresholds being met).',
      },
      coveredSlots: {
        type: 'array',
        description:
          'The answered questions to recap — each { key, prompt }. No respondent values.',
        items: { type: 'object', additionalProperties: true },
      },
      remainingSlots: {
        type: 'array',
        description: 'Optional questions still open — each { key, prompt }.',
        items: { type: 'object', additionalProperties: true },
      },
      recentMessages: {
        type: 'array',
        description: 'Recent user messages, oldest → newest, to match tone.',
        items: { type: 'string' },
      },
      sessionId: {
        type: 'string',
        description: 'Stable session identity, threaded into cost-log metadata.',
      },
    },
    required: ['coverage', 'answeredCount', 'capReached', 'coveredSlots'],
  },
};

/**
 * Slug of the conversational **interviewer** agent that phrases asked questions (the question
 * analogue of {@link QUESTIONNAIRE_COMPLETION_AGENT_SLUG}). Dispatched programmatically by the
 * live `/messages` route's question-stream helper — never a chat tool loop. Carries its own
 * provider-agnostic binding + budget; ships with empty model/provider so it resolves at runtime
 * via `agent-resolver.ts` (the snappy `chat` tier). Seeded by
 * `prisma/seeds/app-questionnaire/026-interviewer-agent.ts`.
 */
export const QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG = 'app-questionnaire-interviewer';

/**
 * Slug of the **data-slot generator** agent. Dispatched programmatically by the
 * generate-data-slots route to infer short (1–4 word) data slots + descriptions + question
 * mappings from a version's approved questions. Provider-agnostic empty binding (resolves at
 * runtime, `reasoning` tier). Seeded by `prisma/seeds/app-questionnaire/029-data-slots-generator-agent.ts`.
 */
export const QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG = 'app-questionnaire-data-slots-generator';

/** Slug of the generate-data-slots capability (source of truth for class + seed row). */
export const GENERATE_DATA_SLOTS_CAPABILITY_SLUG = 'app_generate_data_slots';

/** `AiCapability.executionHandler` for the generate-data-slots capability — the class name. */
export const GENERATE_DATA_SLOTS_HANDLER = 'AppGenerateDataSlotsCapability';

/**
 * The generate-data-slots capability's OpenAI-compatible function definition — shared by the
 * `BaseCapability` subclass and the `AiCapability` seed row so the two can't drift. Dispatched
 * programmatically (not a chat tool loop); `structure` is the opaque questions DTO the
 * capability validates with Zod at execute time.
 */
export const GENERATE_DATA_SLOTS_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  description:
    "Infer a set of semantic data slots — short (1–4 word) names, each with a description and a mapping to the question(s) it abstracts over — from a questionnaire version's approved questions, goal, and audience, via a provider-agnostic structured LLM call. Returns the proposed slots; persists nothing (the admin reviews them).",
  parameters: {
    type: 'object',
    properties: {
      structure: {
        type: 'object',
        description:
          'The version structure DTO: { goal, audience, questions[] } where each question carries its key, prompt, type, and section.',
        additionalProperties: true,
      },
      versionId: {
        type: 'string',
        description: 'Stable version identity, threaded into cost-log metadata.',
      },
    },
    required: ['structure'],
  },
};

/** Slug of the refine-single-data-slot capability (source of truth for class + seed row). */
export const REFINE_DATA_SLOT_CAPABILITY_SLUG = 'app_refine_data_slot';

/** `AiCapability.executionHandler` for the refine-data-slot capability — the class name. */
export const REFINE_DATA_SLOT_HANDLER = 'AppRefineDataSlotCapability';

/**
 * The refine-data-slot capability's OpenAI-compatible function definition — shared by the
 * `BaseCapability` subclass and the `AiCapability` seed row so the two can't drift. Reuses the
 * data-slot generator agent ({@link QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG}); dispatched
 * programmatically by the refine route. Refines ONE existing slot per the admin's free-text
 * instructions, re-grounded against the version's full question set (so it can re-suggest coverage).
 */
export const REFINE_DATA_SLOT_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: REFINE_DATA_SLOT_CAPABILITY_SLUG,
  description:
    "Refine a single data slot — its name, description, theme, and the question(s) it covers — according to the admin's free-text instructions, re-grounded against the questionnaire version's full question set, via a provider-agnostic structured LLM call. Returns the one refined slot; persists nothing (the admin reviews it).",
  parameters: {
    type: 'object',
    properties: {
      structure: {
        type: 'object',
        description:
          'The version structure DTO: { goal, audience, questions[] } — the full question set the refined slot may re-map its coverage against.',
        additionalProperties: true,
      },
      slot: {
        type: 'object',
        description:
          'The current slot to refine: { name, description, theme, questionKeys[] }. The model rewrites it per the instructions.',
        additionalProperties: true,
      },
      instructions: {
        type: 'string',
        description: "The admin's free-text refinement instructions for this slot.",
      },
      versionId: {
        type: 'string',
        description: 'Stable version identity, threaded into cost-log metadata.',
      },
    },
    required: ['structure', 'slot', 'instructions'],
  },
};

/** Slug of the assign-data-slots capability (source of truth for class + seed row). */
export const ASSIGN_DATA_SLOTS_CAPABILITY_SLUG = 'app_assign_data_slots';

/** `AiCapability.executionHandler` for the assign-data-slots capability — the class name. */
export const ASSIGN_DATA_SLOTS_HANDLER = 'AppAssignDataSlotsCapability';

/**
 * The assign-data-slots capability's OpenAI-compatible function definition — shared by the
 * `BaseCapability` subclass and the `AiCapability` seed row so the two can't drift. Reuses the
 * data-slot generator agent ({@link QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG}); dispatched
 * programmatically by the assign route. Places newly-added (unslotted) questions into existing
 * slots or new ones — it only emits placements; the route's deterministic merge does the writing.
 */
export const ASSIGN_DATA_SLOTS_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: ASSIGN_DATA_SLOTS_CAPABILITY_SLUG,
  description:
    "Place newly-added (unslotted) questions into a questionnaire version's existing data slots — or propose new slots for genuinely distinct data points — via a provider-agnostic structured LLM call. Returns one placement per question (existing slot key, or a new slot's name/description/theme); the caller merges deterministically and persists.",
  parameters: {
    type: 'object',
    properties: {
      structure: {
        type: 'object',
        description:
          'The version structure DTO: { goal, audience, questions[] } — context for placing the new questions.',
        additionalProperties: true,
      },
      existingSlots: {
        type: 'array',
        description:
          'The version’s current data slots: [{ key, name, theme, description, questionKeys[] }] — what a new question may join.',
        items: { type: 'object', additionalProperties: true },
      },
      orphanQuestionKeys: {
        type: 'array',
        description: 'Keys of the new questions not yet covered by any slot — place each one.',
        items: { type: 'string' },
      },
      versionId: {
        type: 'string',
        description: 'Stable version identity, threaded into cost-log metadata.',
      },
    },
    required: ['structure', 'existingSlots', 'orphanQuestionKeys'],
  },
};

/**
 * Slug of the evaluate-structure capability (F5.1). One source of truth shared by the
 * `BaseCapability` subclass, its `AiCapability` seed row, and the evaluate-preview
 * route that dispatches it once per dimension. Snake_case with the fork-owned `app_`
 * prefix, like the F4 capabilities. The judge agents themselves are slugged in the
 * dimension registry (`evaluation/dimensions.ts`).
 */
export const EVALUATE_STRUCTURE_CAPABILITY_SLUG = 'app_evaluate_structure';

/**
 * `AiCapability.executionHandler` value for the evaluate-structure capability — the
 * class name the dispatcher resolves the in-memory handler by. Must match the class
 * registered in `lib/app/capabilities.ts`.
 */
export const EVALUATE_STRUCTURE_HANDLER = 'AppEvaluateStructureCapability';

/**
 * The evaluate-structure capability's OpenAI-compatible function definition — the
 * single source of truth shared by the `BaseCapability` subclass and the
 * `AiCapability` seed row, so the two can never drift. Lives here (rather than on the
 * class) so the seed can import it without pulling the capability's orchestration
 * dependency graph into the seed runtime. Dispatched programmatically by the
 * evaluate-preview route — not exposed to a chat tool loop. `structure` is passed as
 * an opaque object (the pure `VersionStructureInput` DTO); the capability validates it
 * with Zod at execute time.
 */
export const EVALUATE_STRUCTURE_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: EVALUATE_STRUCTURE_CAPABILITY_SLUG,
  description:
    "Judge one dimension of a questionnaire version's structure (clarity, coverage, duplicates, type fit, ordering, audience match, or goal match) against its stated goal and audience, via a provider-agnostic structured LLM call. Returns a continuous score in [0, 1] and a list of actionable findings (proposed edits). Dispatched once per dimension by the evaluate-preview route; persists nothing.",
  parameters: {
    type: 'object',
    properties: {
      dimension: {
        type: 'string',
        description:
          'Which dimension to judge: clarity | coverage | duplicates | type_fit | ordering | audience_match | goal_match.',
      },
      structure: {
        type: 'object',
        description:
          'The version structure DTO to judge — { goal, audience, sections[] } with each question carrying its key, prompt, type, and required flag.',
        additionalProperties: true,
      },
      versionId: {
        type: 'string',
        description: 'Stable version identity, threaded into cost-log metadata.',
      },
    },
    required: ['dimension', 'structure'],
  },
};

// ---------------------------------------------------------------------------
// Ingest verify + repair — the extraction critic + scales/matrix repair specialist
// that run between extract and persist on the streaming ingest surface. Both are
// dispatched by the orchestrator (`_lib/orchestrate-extraction.ts`) behind the
// APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR sub-flag; both persist nothing.
// ---------------------------------------------------------------------------

/** Slug of the extraction-verifier capability — the critic that flags mis-typed / mis-scaled questions. */
export const VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG = 'app_verify_extraction_structure';

/** `AiCapability.executionHandler` for the verifier — the class name the dispatcher resolves. */
export const VERIFY_EXTRACTION_STRUCTURE_HANDLER = 'AppVerifyExtractionStructureCapability';

/** Slug of the seeded extraction-verifier `AiAgent` (empty provider/model → dynamic resolution). */
export const QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG = 'app-questionnaire-extraction-verifier';

/**
 * The verifier capability's OpenAI-compatible function definition — one source of truth shared by
 * the `BaseCapability` subclass and the `AiCapability` seed, so they can't drift. Dispatched
 * programmatically by the ingest orchestrator; persists nothing.
 */
export const VERIFY_EXTRACTION_STRUCTURE_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: VERIFY_EXTRACTION_STRUCTURE_CAPABILITY_SLUG,
  description:
    "Verify an extracted questionnaire's questions against the source document text: flag each question whose answer type or config doesn't faithfully match the source (a rating scale mis-typed, a likert missing its endpoint anchors, a rating grid flattened or with rows lost). Returns per-question verdicts plus any detected rating-grid spans; fixes nothing. Dispatched programmatically by the ingest orchestrator.",
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description:
          'The extracted questions to verify — each { key, prompt, suggestedType, suggestedTypeConfig, sourceQuote, extractionConfidence }.',
        items: { type: 'object', additionalProperties: true },
      },
      documentText: {
        type: 'string',
        description: 'The parsed source document text the extraction was produced from.',
      },
      fileName: {
        type: 'string',
        description: 'Original file name (prompt context / cost metadata).',
      },
      versionId: { type: 'string', description: 'Optional stable identity for cost-log metadata.' },
    },
    required: ['questions', 'documentText'],
  },
};

/** Slug of the question-repair capability — the scales/matrix specialist that re-extracts flagged questions. */
export const REPAIR_QUESTIONS_CAPABILITY_SLUG = 'app_repair_questions';

/** `AiCapability.executionHandler` for the repair capability — the class name the dispatcher resolves. */
export const REPAIR_QUESTIONS_HANDLER = 'AppRepairQuestionsCapability';

/** Slug of the seeded scales/matrix repair `AiAgent` (empty provider/model → dynamic resolution). */
export const QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG = 'app-questionnaire-scale-matrix-repair';

/**
 * The repair capability's OpenAI-compatible function definition — one source of truth shared by the
 * `BaseCapability` subclass and the `AiCapability` seed. Dispatched programmatically by the ingest
 * orchestrator over the flagged subset only; persists nothing.
 */
export const REPAIR_QUESTIONS_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: REPAIR_QUESTIONS_CAPABILITY_SLUG,
  description:
    'Re-extract a small set of flagged questions from a questionnaire, correcting their answer type and config against the source (fixing a mis-typed scale, restoring missing likert anchors, or turning a flattened / mis-split rating grid into one matrix question with rows + a shared scale). Returns corrected questions keyed to the originals; persists nothing.',
  parameters: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        description: 'The flagged questions to repair — each the full extracted question object.',
        items: { type: 'object', additionalProperties: true },
      },
      matrixGroups: {
        type: 'array',
        description:
          'Detected rating-grid spans from the verifier — each { label, sourceSpanQuote, memberKeys } so a grid can be re-read whole.',
        items: { type: 'object', additionalProperties: true },
      },
      documentText: {
        type: 'string',
        description: 'The parsed source document text, so a grid span can be re-read in context.',
      },
      fileName: {
        type: 'string',
        description: 'Original file name (prompt context / cost metadata).',
      },
      versionId: { type: 'string', description: 'Optional stable identity for cost-log metadata.' },
    },
    required: ['targets', 'documentText'],
  },
};

// ---------------------------------------------------------------------------
// Generative authoring — compose a questionnaire from a plain-English brief, then
// conversationally refine it (the sibling of document extraction above). Both
// capabilities reuse the extractor's `extractionSchema` output contract.
// ---------------------------------------------------------------------------

/** Slug of the seeded Cohort Report agent (report kind `cohort`); loaded by the generation pipeline. */
export const COHORT_REPORT_AGENT_SLUG = 'app-cohort-report';

/**
 * Slug of the seeded Respondent Report `AiAgent` — assembles the per-respondent insights section
 * (mode `raw_plus_insights`) from the captured answers, the admin's generation config, and the
 * optional client knowledge base. Ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`; the generation pipeline loads it by slug. App-prefixed to avoid collision
 * with core agents. Seeded by `045-respondent-report-agent.ts`.
 */
export const RESPONDENT_REPORT_AGENT_SLUG = 'app-respondent-report';

/**
 * Slug of the seeded Respondent Report **config assistant** `AiAgent` — the conversational helper in
 * the Generation tab that interviews the admin and proposes report generation config (instructions /
 * structure / background context). Distinct from the report WRITER agent: this one authors config,
 * it doesn't write respondent-facing reports. Empty `model`/`provider` (runtime-resolved); seeded by
 * `046-report-config-assistant-agent.ts`.
 */
export const RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG = 'app-respondent-report-assistant';

/**
 * Slug of the seeded **Report Formatter** `AiAgent` — the second-pass agent that takes a generated
 * report's prose (from the Respondent Report writer, and later the Cohort Report) and does form-only
 * work: re-paragraphs at natural boundaries, converts inline dash-runs into bullet lists, and strips
 * AI-isms (em-dash overuse, flowery filler). It must not add, remove, or alter any fact, heading,
 * section, or action — a strict fidelity guard in `report/format.ts` falls back to the unformatted
 * content on any structural drift. Report-kind-agnostic (operates on the shared
 * `summary / sections[{heading,body}] / actions` core). Empty `model`/`provider` (runtime-resolved at
 * the cheaper `chat` tier — formatting is largely mechanical); seeded by `061-report-formatter-agent.ts`.
 */
export const REPORT_FORMATTER_AGENT_SLUG = 'app-report-formatter';

/**
 * Slug of the seeded **Report Research** `AiAgent` — the web-research assistant that runs the report's
 * search rounds: it plans a query, calls the `web_search` tool, refines across rounds (building on
 * prior results), and returns a cited findings digest. Report-kind-agnostic (respondent + cohort).
 * Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` (reasoning
 * tier — query refinement + synthesis is reasoning-heavy). Seeded by `070-report-researcher-agent.ts`;
 * bound to the `web_search` capability by `071-web-search-capability.ts`.
 */
export const REPORT_RESEARCHER_AGENT_SLUG = 'app-report-researcher';

/**
 * Slug of the **web_search** capability — a thin, provider-agnostic web-search tool (Brave backend
 * today; Tavily is a drop-in second backend behind the same normalized result shape). Query-in /
 * clean-results-out, with the query length-guarded under Brave's 400-char `q` cap. Registered via the
 * app seam (`lib/app/capabilities.ts`); **promotable to a Sunrise built-in** later. Single source of
 * truth shared by the `BaseCapability` subclass and its `AiCapability` seed row.
 */
export const WEB_SEARCH_CAPABILITY_SLUG = 'web_search';

/** `AiCapability.executionHandler` for the web_search capability — the class name the dispatcher
 * resolves the in-memory handler by. Must match `lib/app/capabilities.ts`. */
export const WEB_SEARCH_HANDLER = 'AppWebSearchCapability';

/** Env var (name, not value) holding the Brave Search API key. Resolved at call time; never logged,
 * never exposed to the LLM. Matches the provider-model-audit workflow's `authSecret`. */
export const BRAVE_SEARCH_API_KEY_ENV = 'BRAVE_SEARCH_API_KEY';

/** Brave Search host — must be present in `ORCHESTRATION_ALLOWED_HOSTS` for searches to run. */
export const BRAVE_SEARCH_HOST = 'api.search.brave.com';

/**
 * The web_search capability's OpenAI-compatible function definition — single source of truth shared by
 * the `BaseCapability` subclass and the `AiCapability` seed row, so the two can never drift. Exposed
 * to the research agent's tool loop (unlike the programmatically-dispatched app capabilities).
 */
export const WEB_SEARCH_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: WEB_SEARCH_CAPABILITY_SLUG,
  description:
    'Search the public web for up-to-date information and return ranked results (title, url, snippet). Use it to gather external context or verify facts. Issue one focused query per call; refine the query on the next call based on what the previous results returned. Keep queries short (under ~380 characters).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A focused web-search query. Keep it under ~380 characters.',
        maxLength: 380,
      },
      count: {
        type: 'number',
        description: 'How many results to return (1–10). Defaults to 5.',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['query'],
  },
};

/**
 * Slug of the seeded composer `AiAgent` (generative authoring). A distinct agent
 * from the document extractor: composition and document extraction carry their
 * own budgets and personas. Ships with empty `model`/`provider` so it resolves
 * dynamically via `agent-resolver.ts`; the compose/refine routes load it to
 * populate the dispatch context. App-prefixed to avoid collision with core agents.
 */
export const QUESTIONNAIRE_COMPOSER_AGENT_SLUG = 'app-questionnaire-composer';

/**
 * Slug of the seeded Config Advisor `AiAgent`. A distinct agent from the composer/extractor:
 * the advisor evaluates an existing configuration rather than authoring structure, and carries its
 * own budget + persona. Ships with empty `model`/`provider` so it resolves dynamically via
 * `agent-resolver.ts`; the advisor route loads it by slug. App-prefixed to avoid collision with
 * core agents. Seeded by `057-advisor-agent.ts`.
 */
export const QUESTIONNAIRE_ADVISOR_AGENT_SLUG = 'app-questionnaire-advisor';

/**
 * Slug of the seeded Structure Edit Agent `AiAgent`. A distinct agent from the composer/advisor:
 * it interprets a free-text instruction into a list of deterministic structural edit operations
 * over an existing draft (it does not author prose or evaluate config), and carries its own budget
 * + persona. Ships with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts`;
 * the plan route loads it by slug. App-prefixed to avoid collision with core agents. Seeded by
 * `060-edit-agent.ts`, surfaced in Agent Settings via `AGENT_RECOMMENDATIONS`.
 */
export const QUESTIONNAIRE_EDIT_AGENT_SLUG = 'app-questionnaire-structure-editor';

/**
 * Slug of the seeded **Turn Evaluator** judge `AiAgent` — the interview-quality evaluator the
 * Preview Turn Inspector runs over ONE completed turn (`lib/app/questionnaire/turn-evaluation`).
 * Unlike the other questionnaire agents it is NOT `app-`prefixed: it is a generic reasoning judge
 * seeded by `prisma/seeds/app-questionnaire/043-turn-evaluator-agent.ts`. Ships with empty
 * `model`/`provider` so it resolves dynamically via `agent-resolver.ts` (reasoning tier); the
 * evaluate-turn route loads it by slug. Its load-bearing rubric lives in code
 * (`turn-evaluation/prompt.ts`), not the seeded `systemInstructions`. Re-exported from
 * `agent-advisory/recommendations.ts` for back-compat.
 */
export const TURN_EVALUATOR_AGENT_SLUG = 'turn-evaluator';

/** Slug of the compose-from-brief capability. One source of truth shared by the
 * `BaseCapability` subclass, its `AiCapability` seed row, and the compose routes. */
export const COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG = 'app_compose_questionnaire';

/** `AiCapability.executionHandler` for the compose capability — the class name the
 * dispatcher resolves the in-memory handler by. Must match `lib/app/capabilities.ts`. */
export const COMPOSE_QUESTIONNAIRE_HANDLER = 'AppComposeQuestionnaireCapability';

/**
 * The compose capability's OpenAI-compatible function definition — single source
 * of truth shared by the `BaseCapability` subclass and the `AiCapability` seed row,
 * so the two can never drift. Dispatched programmatically by the compose route —
 * not exposed to a chat tool loop.
 */
export const COMPOSE_QUESTIONNAIRE_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
  description:
    'Compose an opinionated, structured questionnaire (sections, questions with inferred types, an inferred goal/audience) from a plain-English brief — no source document. Returns the same structure contract as the extractor with an empty change log (nothing was edited; everything was generated). Dispatched programmatically by the compose route.',
  parameters: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description:
          'Plain-English description of the questionnaire to build (goal, audience, topics to cover).',
      },
      adminProvidedGoal: {
        type: 'string',
        description:
          'Goal the admin set explicitly. When present, the composer uses it verbatim and does NOT infer the goal.',
      },
      adminProvidedAudience: {
        type: 'object',
        description:
          'Audience fields the admin set explicitly. Inference is suppressed per supplied field.',
        additionalProperties: true,
      },
    },
    required: ['brief'],
  },
};

/** Slug of the refine-questionnaire-structure capability (the conversational-refine
 * turn of generative authoring). Reuses the composer agent. */
export const REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG = 'app_refine_questionnaire_structure';

/** `AiCapability.executionHandler` for the refine-structure capability. */
export const REFINE_QUESTIONNAIRE_STRUCTURE_HANDLER = 'AppRefineQuestionnaireStructureCapability';

/**
 * The refine-structure capability's OpenAI-compatible function definition. Takes
 * the current structure plus a natural-language instruction and returns the
 * updated structure (same contract) plus a short human-readable change summary.
 */
export const REFINE_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  description:
    'Apply a natural-language instruction ("make it shorter", "add a section on pricing") to an existing questionnaire structure and return the full updated structure plus a one-line summary of what changed. Dispatched programmatically by the compose-refine route.',
  parameters: {
    type: 'object',
    properties: {
      currentStructure: {
        type: 'object',
        description:
          'The current questionnaire structure to refine — { goal?, audience?, sections[], questions[] }.',
        additionalProperties: true,
      },
      instruction: {
        type: 'string',
        description: "The admin's plain-English refinement instruction for this turn.",
      },
    },
    required: ['currentStructure', 'instruction'],
  },
};

/** Slug of the author-intro-background capability — generate or refine the respondent intro
 * "about this questionnaire" markdown (F12.2). Reuses the composer agent. */
export const AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG = 'app_author_intro_background';

/** `AiCapability.executionHandler` for the author-intro-background capability. */
export const AUTHOR_INTRO_BACKGROUND_HANDLER = 'AppAuthorIntroBackgroundCapability';

/**
 * The author-intro-background capability's OpenAI-compatible function definition — single source of
 * truth shared by the `BaseCapability` subclass and the `AiCapability` seed row. `generate` writes a
 * fresh intro section from a brief; `refine` rewrites supplied text per an instruction. Returns
 * `{ background }` (markdown). Dispatched programmatically by the intro-background author route.
 */
export const AUTHOR_INTRO_BACKGROUND_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG,
  description:
    'Write or refine the respondent-facing "about this questionnaire" intro section (markdown). mode=generate composes a fresh section from a plain-English brief; mode=refine rewrites the supplied current text per an instruction. Returns { background } markdown. Dispatched programmatically by the intro-background author route.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['generate', 'refine'],
        description:
          'generate = compose from a brief; refine = rewrite currentText per instruction.',
      },
      brief: {
        type: 'string',
        description:
          'Plain-English description of the questionnaire / company / purpose (generate).',
      },
      currentText: {
        type: 'string',
        description: 'The current intro markdown to rewrite (refine).',
      },
      instruction: {
        type: 'string',
        description: "The admin's plain-English instruction for how to rewrite the text (refine).",
      },
      questionnaireContext: {
        type: 'string',
        description:
          "Optional pre-formatted summary of the questionnaire's goal + questions, used to ground a generated intro in the subject matter (generate). Injected by the route, not the LLM.",
      },
    },
    required: ['mode'],
  },
};

/**
 * Slug of the suggest-round-briefing capability — the "have an agent evaluate the questionnaire and
 * propose interviewer briefing notes" flow. One source of truth shared by the `BaseCapability`
 * subclass, its `AiCapability` seed row, and the suggest route. Reuses the composer agent.
 */
export const SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG = 'app_suggest_round_briefing';

/** `AiCapability.executionHandler` for the suggest-round-briefing capability. */
export const SUGGEST_ROUND_BRIEFING_HANDLER = 'AppSuggestRoundBriefingCapability';

/**
 * The suggest-round-briefing capability's OpenAI-compatible function definition — single source of
 * truth shared by the `BaseCapability` subclass and the `AiCapability` seed row. Given a
 * questionnaire's goal + questions (and optional admin-supplied source material), it proposes a set
 * of interviewer-briefing notes — facts/figures/background that would help the interviewer ask each
 * question well — each optionally attributed to one of the provided question ids. Returns
 * `{ entries: [{ questionId?, title, content }] }`. The route maps the proposals back for admin
 * review; nothing is persisted by the capability. Dispatched programmatically by the suggest route.
 */
export const SUGGEST_ROUND_BRIEFING_FUNCTION_DEFINITION: CapabilityFunctionDefinition = {
  name: SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG,
  description:
    'Evaluate a questionnaire and propose interviewer "briefing" notes — facts, figures, and background that would help an interviewer ask its questions knowledgeably. Each note may be attributed to one provided question id (a focused briefing) or left general (whole-questionnaire). Use any admin-supplied source material as the factual basis; otherwise suggest the KINDS of background worth gathering, framed as prompts to the admin. Returns { entries: [{ questionId?, title, content }] }. Dispatched programmatically by the suggest route.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The questionnaire goal, for framing (optional).',
      },
      questions: {
        type: 'array',
        description:
          'The questions a note may be attributed to: [{ id, prompt, sectionTitle }]. A proposed entry’s questionId, when set, MUST be one of these ids.',
        items: { type: 'object', additionalProperties: true },
      },
      sourceText: {
        type: 'string',
        description:
          'Optional admin-supplied background material (pasted or extracted from an upload) to base the notes on. When absent, propose the kinds of background worth gathering.',
      },
      maxEntries: {
        type: 'number',
        description: 'Soft cap on how many briefing notes to propose.',
      },
    },
    required: ['questions'],
  },
};
