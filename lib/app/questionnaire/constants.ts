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

/**
 * Sub-flag gating F4.5 **completion-offer composition** (the LLM call that phrases the
 * offer-to-submit message once the deterministic gate decides the questionnaire is
 * done enough). Disabled by default: it spends an LLM call per offer, so an operator
 * opts in deliberately — the same reasoning as the sub-flags above. Independent of
 * {@link APP_QUESTIONNAIRES_FLAG} (the master gate); both must be on for the
 * completion-status route to compose an offer. The deterministic assessment itself is
 * always available under the master flag — only the LLM phrasing is gated. Seeded by
 * `prisma/seeds/app-questionnaire/017-completion-flag.ts`.
 */
export const APP_QUESTIONNAIRES_COMPLETION_FLAG = 'APP_QUESTIONNAIRES_COMPLETION_ENABLED';

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
 * Sub-flag gating the F5.1 **design-time evaluation** judges (the LLM panel that
 * scores a version's structure against its goal/audience and proposes edits). Disabled
 * by default: a run spends seven LLM calls, so an operator opts in deliberately — the
 * same reasoning as the F4 sub-flags above. Independent of {@link APP_QUESTIONNAIRES_FLAG}
 * (the master gate); both must be on for the evaluate-preview route to run. Seeded by
 * `prisma/seeds/app-questionnaire/019-design-evaluation-flag.ts`.
 */
export const APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG =
  'APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED';

/**
 * Sub-flag gating the **turn evaluation** agent — the admin-only "interview-quality
 * evaluator" the Preview Turn Inspector runs over a single completed turn, judging
 * instruction compliance, interviewing/extraction/selection quality, information gain,
 * missed opportunities, prompt drift, and cost/efficiency. Disabled by default: each run
 * spends one reasoning-model call, so an operator opts in deliberately — the same reasoning
 * as the design-evaluation sub-flag. Independent of {@link APP_QUESTIONNAIRES_FLAG} (the
 * master gate); both must be on for the evaluate-turn route to run. The route, like the
 * inspector it serves, additionally requires the session to be a preview. Seeded by
 * `prisma/seeds/app-questionnaire/042-turn-evaluation-flag.ts`.
 */
export const APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG = 'APP_QUESTIONNAIRES_TURN_EVALUATION_ENABLED';

/**
 * Sub-flag gating the F6.1 **live respondent sessions** surface — the streaming turn
 * loop a real respondent drives (create a session, send messages, get a streamed reply).
 * Disabled by default so the live surface dark-launches independently of the admin
 * preview routes (which run under the master flag alone): a master-on app shouldn't expose
 * respondent sessions until an operator deliberately turns them on. Independent of
 * {@link APP_QUESTIONNAIRES_FLAG}; both must be on for the session-create + messages routes
 * to run. Seeded by `prisma/seeds/app-questionnaire/021-live-sessions-flag.ts`.
 */
export const APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG = 'APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED';

/**
 * Sub-flag gating F6.2 **voice input** — the respondent transcribe endpoint
 * (`POST /api/v1/app/questionnaire-sessions/:id/transcribe`) that turns recorded audio into
 * text via Sunrise's audio provider (OpenAI Whisper). Disabled by default: every call spends
 * per-minute transcription cost, so an operator turns it on deliberately. The transcribe route
 * requires the master flag, the live-sessions flag, AND this voice sub-flag — voice *depends on*
 * live-sessions (a transcript is only useful if the respondent can then send it through the live
 * `/messages` turn loop), so it's an opt-in on top of that prerequisite, not an independent
 * surface. When any of the three is off the route returns 404, so a disabled sub-feature looks
 * like a missing route rather than a 401. Seeded by
 * `prisma/seeds/app-questionnaire/022-voice-input-flag.ts`.
 */
export const APP_QUESTIONNAIRES_VOICE_INPUT_FLAG = 'APP_QUESTIONNAIRES_VOICE_INPUT_ENABLED';

/**
 * Sub-flag gating F6.3 **cost-cap enforcement** — the per-session USD budget enforced at the
 * turn boundary (soft nudge at ≥90%, hard 402 + auto-pause at ≥100%). Disabled by default so
 * enforcement dark-launches independently: a live-sessions deployment runs unmetered until an
 * operator deliberately turns the cap on, and it can be switched off again without touching the
 * live surface. Requires the master flag AND the live-sessions flag (the cap only applies to the
 * live `/messages` turn loop) AND this sub-flag; when off, turns run with no budget check even if
 * a version sets `costBudgetUsd`. Seeded by `prisma/seeds/app-questionnaire/023-cost-cap-flag.ts`.
 */
export const APP_QUESTIONNAIRES_COST_CAP_FLAG = 'APP_QUESTIONNAIRES_COST_CAP_ENABLED';

/**
 * Sub-flag gating **attachment input** — letting a respondent attach images/documents to a
 * `/messages` turn so the answer-extractor reads them alongside the text. Disabled by default:
 * multimodal turns spend more and require a vision/document-capable model. Requires the master
 * flag AND the live-sessions flag (attachments only apply to the live turn loop) AND this
 * sub-flag; when off, the chat surface hides the affordance and the route ignores any attachments
 * a client sends (text-only turn), so the paid multimodal path can't be reached. Seeded by
 * `prisma/seeds/app-questionnaire/024-attachment-input-flag.ts`.
 */
export const APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG =
  'APP_QUESTIONNAIRES_ATTACHMENT_INPUT_ENABLED';

/**
 * Sub-flag gating **conversational question phrasing** — the interviewer pass that renders the
 * next question as warm, natural prose (acknowledging the prior answer, calibrating tone to the
 * audience/locale, and re-asking conversationally) instead of surfacing the raw question prompt
 * verbatim. This restores the originally-planned "warm conversational interviewer" voice that
 * F6.1's deterministic orchestrator dropped when it chose the app-native pipeline over
 * `streamChat`. Disabled by default: it spends one extra LLM call per asked question, so an
 * operator opts in deliberately — the same reasoning as the F4 sub-flags. Requires the master
 * flag AND the live-sessions flag (phrasing only applies inside the live `/messages` turn loop)
 * AND this sub-flag; when off, the route falls back to the verbatim prompt (no extra spend, no
 * behaviour change). Fail-soft at runtime too: a missing agent/provider or a stream error drops
 * back to the verbatim prompt, so a question is never lost. Seeded by
 * `prisma/seeds/app-questionnaire/027-question-phrasing-flag.ts`.
 */
export const APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG =
  'APP_QUESTIONNAIRES_QUESTION_PHRASING_ENABLED';

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
 * Sub-flag gating the **data slots** feature — the semantic abstraction layer over questions.
 * When on: the admin can generate + review data slots, every launch requires them, and a
 * launched questionnaire with data slots runs its live session in "data-slot mode" (the
 * conversation targets data slots; questions fill in the background). Disabled by default;
 * gates both the admin generation surface (master flag) and the runtime mode (additionally
 * requires the live-sessions flag, enforced by the `/messages` route). Seeded by
 * `prisma/seeds/app-questionnaire/028-data-slots-flag.ts`.
 */
export const APP_QUESTIONNAIRES_DATA_SLOTS_FLAG = 'APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED';

/**
 * Sub-flag gating **adaptive data-slot selection** — the embedding-ranked LLM selector that picks
 * the next data slot to pursue in data-slot mode, instead of the deterministic topic-local order.
 * A paid (embedding + LLM) sub-feature aimed at large questionnaires (50+ data slots): it depends
 * on the data-slots feature AND live-sessions, and is an independent opt-in on top. When off, the
 * data-slot turn loop keeps today's deterministic `pickNextDataSlot`. Disabled by default
 * (dark-launch). Seeded by `prisma/seeds/app-questionnaire/041-adaptive-data-slots-flag.ts`.
 */
export const APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG =
  'APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_ENABLED';

/**
 * Sub-flag gating the **seriousness / abuse gate** — per answered turn, a respondent answer the
 * extractor flags as non-genuine is judged; a non-serious verdict is disregarded, strikes the
 * session, and (at `config.abuseThreshold`) abandons it. Disabled by default (dark-launch);
 * requires the master app flag AND the live-sessions flag (the gate only runs inside the live
 * `/messages` turn loop) AND this sub-flag. Seeded by
 * `prisma/seeds/app-questionnaire/029-seriousness-gate-flag.ts`.
 */
export const APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG =
  'APP_QUESTIONNAIRES_SERIOUSNESS_GATE_ENABLED';

/**
 * Sub-flag gating **sensitivity awareness / safeguarding** — per answered turn, the extractor also
 * flags a genuine sensitive/contentious disclosure; the core remembers it (running-max level +
 * notes), softens later phrasing, and signposts support once on a serious disclosure. Disabled by
 * default (dark-launch); requires the master app flag AND the live-sessions flag (it only runs in
 * the live `/messages` turn loop) AND this sub-flag, AND the per-questionnaire `sensitivityAwareness`
 * config toggle. Seeded by `prisma/seeds/app-questionnaire/030-sensitivity-awareness-flag.ts`.
 */
export const APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG =
  'APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_ENABLED';

/**
 * Sub-flag gating **frictionless invite links** — a per-invitee token that boots a no-login session
 * directly (the respondent answers without registering an account; optional account creation stays
 * for cross-device resume). Requires the master app flag AND the live-sessions flag AND this
 * sub-flag. When off, invitations fall back to the account-registration accept flow. Seeded by
 * `prisma/seeds/app-questionnaire/033-frictionless-invites-flag.ts`.
 */
export const APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG =
  'APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_ENABLED';

/**
 * Sub-flag gating **invitee import + AI extraction** — the import wizard's CSV/PDF/image methods and
 * the paid LLM people-extraction capability. Requires the master app flag AND this sub-flag (the
 * AI paths spend per call and handle PII). When off, the admin can still add invitees by typing them
 * directly. Seeded by `prisma/seeds/app-questionnaire/034-invite-import-flag.ts`.
 */
export const APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG = 'APP_QUESTIONNAIRES_INVITE_IMPORT_ENABLED';

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
// Generative authoring — compose a questionnaire from a plain-English brief, then
// conversationally refine it (the sibling of document extraction above). Both
// capabilities reuse the extractor's `extractionSchema` output contract.
// ---------------------------------------------------------------------------

/**
 * Sub-flag gating the generative-authoring surface (compose-from-brief + refine).
 * DB-backed, seeded disabled by `035-generative-authoring-flag.ts`. Opt-in on top
 * of {@link APP_QUESTIONNAIRES_FLAG}; both must be on. Each compose/refine run is
 * ≥1 reasoning LLM call, so it dark-launches independently of document ingestion.
 */
export const APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG =
  'APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_ENABLED';

/**
 * Platform feature flag gating the live "watch it think" **reasoning stream** (demo feature) —
 * the per-turn reasoning trace shown beside the respondent chat. DB-backed, seeded disabled by
 * `036-reasoning-stream-flag.ts`. Depends on live-sessions (it only matters inside the `/messages`
 * turn loop) and ANDs with the per-version `reasoningStreamEnabled` config toggle. Carries no extra
 * LLM cost — the trace is derived from work the turn already did — but it's a respondent-facing
 * surface, so it dark-launches behind its own flag.
 */
export const APP_QUESTIONNAIRES_REASONING_STREAM_FLAG =
  'APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED';

/**
 * Platform feature flag gating **interviewer tone & persona** (F-tone) — the per-version sliders
 * (empathy, mirroring, formality, mimicry, verbosity, warmth, curiosity, reading complexity,
 * humour) plus the free-text persona that shape how the conversational interviewer responds.
 * DB-backed, seeded disabled by `037-tone-flag.ts`. ANDs with each per-version dimension toggle;
 * when off the phraser keeps today's default voice (`buildToneInstructions` is never consulted).
 */
export const APP_QUESTIONNAIRES_TONE_FLAG = 'APP_QUESTIONNAIRES_TONE_ENABLED';

/**
 * Slug of the seeded composer `AiAgent` (generative authoring). A distinct agent
 * from the document extractor: composition and document extraction carry their
 * own budgets and personas. Ships with empty `model`/`provider` so it resolves
 * dynamically via `agent-resolver.ts`; the compose/refine routes load it to
 * populate the dispatch context. App-prefixed to avoid collision with core agents.
 */
export const QUESTIONNAIRE_COMPOSER_AGENT_SLUG = 'app-questionnaire-composer';

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
