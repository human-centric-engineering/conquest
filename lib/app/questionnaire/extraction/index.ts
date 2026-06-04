/**
 * Public surface of the questionnaire answer-extraction core (F4.2).
 *
 * Pure, DB-free: the in-memory shapes, the Zod LLM contract + its JSON-schema,
 * the per-type value validator, the prompt builder, and the answer-intent
 * normaliser. The extractor capability and the preview route consume these;
 * nothing here imports Prisma/Next.js.
 */

export type {
  ExtractionContext,
  ExtractionSlotView,
  ExtractionAnsweredView,
  AnswerSlotIntent,
  AnswerExtractionResult,
  DroppedAnswer,
} from '@/lib/app/questionnaire/extraction/types';

export {
  answerExtractionSchema,
  answerExtractionJsonSchema,
  validateAnswerExtraction,
  type ExtractedAnswer,
  type AnswerExtraction,
  type AnswerExtractionValidation,
} from '@/lib/app/questionnaire/extraction/extraction-schema';

export {
  validateAnswerValue,
  type AnswerValueValidation,
} from '@/lib/app/questionnaire/extraction/answer-value';

export {
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';

export { normalizeAnswerIntents } from '@/lib/app/questionnaire/extraction/answer-intents';

/**
 * The provenance labels the F4.2 extractor emits, re-exported for the parity test
 * that asserts the contract enum and the shared vocabulary stay in lock-step
 * (mirrors selection's `KNOWN_STRATEGY_SLUGS`). Sourced from the single tuple in
 * `../types.ts`.
 */
export {
  ANSWER_PROVENANCES,
  EXTRACTOR_EMITTED_PROVENANCES,
  type AnswerProvenance,
} from '@/lib/app/questionnaire/types';
