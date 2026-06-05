/**
 * Public surface of the questionnaire completion-logic core (F4.5).
 *
 * Pure, DB-free: the in-memory shapes, the deterministic assessment + resolution
 * logic, the Zod offer contract + its JSON-schema, and the offer prompt builder. The
 * completion-offer capability and the preview routes consume these; nothing here
 * imports Prisma / Next.js.
 */

export {
  COMPLETION_KINDS,
  type CompletionKind,
  UNMET_CRITERIA,
  type UnmetCriterion,
  COMPLETION_ACTIONS,
  type CompletionAction,
  type CompletionContext,
  type CompletionAssessment,
  type CompletionResolution,
  type CompletionSweepResult,
  type CompletionOffer,
} from '@/lib/app/questionnaire/completion/types';

export {
  assessCompletion,
  resolveCompletion,
} from '@/lib/app/questionnaire/completion/completion-logic';

export {
  completionOfferSchema,
  completionOfferJsonSchema,
  validateCompletionOffer,
  type CompletionOfferOutput,
  type CompletionOfferValidation,
} from '@/lib/app/questionnaire/completion/completion-schema';

export {
  buildCompletionOfferPrompt,
  buildCompletionOfferRetryMessage,
  type CompletionPromptSlot,
  type CompletionOfferPromptInput,
} from '@/lib/app/questionnaire/completion/completion-prompt';
