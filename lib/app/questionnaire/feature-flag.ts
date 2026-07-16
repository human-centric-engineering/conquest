import type { NextRequest } from 'next/server';

import {
  APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
  APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
  APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
  APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_FLAG,
  APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
  APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG,
  APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG,
  APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG,
  APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG,
  APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG,
  APP_QUESTIONNAIRES_REASONING_STREAM_FLAG,
  APP_QUESTIONNAIRES_TONE_FLAG,
  APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG,
  APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG,
  APP_QUESTIONNAIRES_COHORTS_FLAG,
  APP_QUESTIONNAIRES_COHORT_REPORT_FLAG,
  APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG,
  APP_QUESTIONNAIRES_ROUND_CONTEXT_FLAG,
  APP_QUESTIONNAIRES_LEARNING_MODE_FLAG,
  APP_QUESTIONNAIRES_ROUND_PHASES_FLAG,
  APP_QUESTIONNAIRES_ADVISOR_FLAG,
  APP_QUESTIONNAIRES_EDIT_AGENT_FLAG,
  APP_QUESTIONNAIRES_FLAG,
} from '@/lib/app/questionnaire/constants';

// Re-exported so the feature-flag module stays the natural home for the flag
// name. The constant itself lives in the dependency-light `constants.ts` so leaf
// consumers (the seed) can import it without this module's HTTP/DB deps.
export {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
  APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
  APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
  APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_FLAG,
  APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
  APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG,
  APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG,
  APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG,
  APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG,
  APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG,
  APP_QUESTIONNAIRES_REASONING_STREAM_FLAG,
  APP_QUESTIONNAIRES_TONE_FLAG,
  APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG,
  APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG,
  APP_QUESTIONNAIRES_COHORTS_FLAG,
  APP_QUESTIONNAIRES_COHORT_REPORT_FLAG,
  APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG,
  APP_QUESTIONNAIRES_ROUND_CONTEXT_FLAG,
  APP_QUESTIONNAIRES_LEARNING_MODE_FLAG,
  APP_QUESTIONNAIRES_ROUND_PHASES_FLAG,
  APP_QUESTIONNAIRES_ADVISOR_FLAG,
  APP_QUESTIONNAIRES_EDIT_AGENT_FLAG,
};

/**
 * The ConQuest questionnaire feature flags have been retired: every questionnaire
 * feature is now permanently on. These resolvers are kept only as always-enabled
 * shims so that call sites still compiling against them behave as "on"; call sites
 * are being unwound to drop them, after which this module is deleted. The only
 * runtime toggle left in the system is site-wide maintenance mode.
 *
 * Every `is*Enabled` returns `true`, every `ensure*Enabled` returns `null` (never
 * blocks), and every `with*Enabled` is a passthrough (auth still runs inside each
 * wrapped handler, so passthrough preserves auth exactly).
 */

type RouteHandler<C> = (request: NextRequest, context: C) => Promise<Response>;

const passthrough = <C>(handler: RouteHandler<C>): RouteHandler<C> => handler;

export function isQuestionnairesEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isAdaptiveSelectionEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isAnswerExtractionEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isContradictionDetectionEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isAnswerRefinementEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isCompletionEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isDesignEvaluationEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isIngestVerifyRepairEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isTurnEvaluationEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureTurnEvaluationEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withTurnEvaluationEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isGenerativeAuthoringEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureGenerativeAuthoringEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withGenerativeAuthoringEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isEditAgentEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureEditAgentEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withEditAgentEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function ensureQuestionnairesEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withQuestionnairesEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isLiveSessionsEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureLiveSessionsEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withLiveSessionsEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isVoiceInputEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isAttachmentInputEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isFrictionlessInvitesEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isInvitationImportEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isQuestionPhrasingEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isDataSlotsEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isAdaptiveDataSlotSelectionEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureVoiceInputEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withVoiceInputEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isCostCapEnforcementEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isSeriousnessGateEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isSensitivityAwarenessEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isReasoningStreamEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isToneEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isCohortsEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function isIntroScreenEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureIntroScreenEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withIntroScreenEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isPersonaSelectionEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensurePersonaSelectionEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withPersonaSelectionEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function ensureCohortsEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withCohortsEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isRoundContextEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureRoundContextEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withRoundContextEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isLearningModeEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureLearningModeEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withLearningModeEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isRoundPhasesEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureRoundPhasesEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withRoundPhasesEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isCohortReportEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureCohortReportEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withCohortReportEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}

export function isAdvisorEnabled(): Promise<boolean> {
  return Promise.resolve(true);
}

export function ensureAdvisorEnabled(): Promise<Response | null> {
  return Promise.resolve(null);
}

export function withAdvisorEnabled<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return passthrough(handler);
}
