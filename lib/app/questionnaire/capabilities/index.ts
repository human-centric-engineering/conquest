/**
 * Public surface of the questionnaire app's capabilities (F1.1).
 *
 * Barrel re-export so the app's capability-registration hook
 * (`lib/app/capabilities.ts`) and the ingestion route (PR4) import from one
 * place. Each capability is a `BaseCapability` subclass dispatched
 * programmatically via `capabilityDispatcher.dispatch()`.
 */

export {
  AppExtractQuestionnaireStructureCapability,
  type ExtractQuestionnaireStructureArgs,
  type ExtractQuestionnaireStructureData,
} from '@/lib/app/questionnaire/capabilities/extract-questionnaire-structure';

export {
  AppExtractAnswerSlotsCapability,
  type ExtractAnswerSlotsArgs,
  type ExtractAnswerSlotsData,
} from '@/lib/app/questionnaire/capabilities/extract-answer-slots';

export {
  AppDetectContradictionsCapability,
  MAX_CONTRADICTION_SLOTS,
  MAX_CONTRADICTION_ANSWERS,
  type DetectContradictionsArgs,
  type DetectContradictionsData,
} from '@/lib/app/questionnaire/capabilities/detect-contradictions';

export {
  AppRefineAnswerCapability,
  MAX_REFINEMENT_SLOTS,
  MAX_REFINEMENT_ANSWERS,
  type RefineAnswerArgs,
  type RefineAnswerData,
} from '@/lib/app/questionnaire/capabilities/refine-answer';

export {
  AppComposeCompletionOfferCapability,
  MAX_COMPLETION_COVERED_SLOTS,
  MAX_COMPLETION_REMAINING_SLOTS,
  MAX_COMPLETION_RECENT_MESSAGES,
  type ComposeCompletionOfferArgs,
  type ComposeCompletionOfferData,
} from '@/lib/app/questionnaire/capabilities/compose-completion-offer';

export {
  AppEvaluateStructureCapability,
  type EvaluateStructureArgs,
  type EvaluateStructureData,
} from '@/lib/app/questionnaire/capabilities/evaluate-structure';

export {
  AppGenerateDataSlotsCapability,
  type GenerateDataSlotsArgs,
  type GenerateDataSlotsData,
} from '@/lib/app/questionnaire/capabilities/generate-data-slots';

export {
  AppRefineDataSlotCapability,
  type RefineDataSlotArgs,
  type RefineDataSlotData,
} from '@/lib/app/questionnaire/capabilities/refine-data-slot';

export {
  AppAssignDataSlotsCapability,
  type AssignDataSlotsArgs,
  type AssignDataSlotsData,
} from '@/lib/app/questionnaire/capabilities/assign-data-slots';

export {
  AppComposeQuestionnaireCapability,
  type ComposeQuestionnaireArgs,
  type ComposeQuestionnaireData,
} from '@/lib/app/questionnaire/capabilities/compose-questionnaire';

export {
  AppRefineQuestionnaireStructureCapability,
  type RefineQuestionnaireStructureArgs,
  type RefineQuestionnaireStructureData,
} from '@/lib/app/questionnaire/capabilities/refine-questionnaire-structure';
