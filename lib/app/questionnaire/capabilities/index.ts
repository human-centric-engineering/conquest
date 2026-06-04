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
