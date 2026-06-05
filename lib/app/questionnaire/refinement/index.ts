/**
 * Public surface of the questionnaire answer-refinement core (F4.4).
 *
 * Pure, DB-free: the in-memory shapes, the Zod LLM contract + its JSON-schema, the
 * prompt builder, the decision normaliser, and the deterministic value-merge. The
 * refiner capability and the preview route consume these; nothing here imports
 * Prisma/Next.js. (Persistence lives in the route's `_lib` seam, which calls
 * {@link applyRefinement} on the result of this core.)
 */

export {
  REFINEMENT_ACTIONS,
  REFINEMENT_SOURCES,
  type RefinementAction,
  type RefinementSource,
  type RefinementSlotView,
  type ExistingAnswerView,
  type RefinementHistoryEntry,
  type RefinementContext,
  type RefinementDecision,
  type RefinedSlotState,
  type DroppedRefinement,
  type RefinementResult,
  type RefinementSummary,
} from '@/lib/app/questionnaire/refinement/types';

export {
  refinementSchema,
  refinementJsonSchema,
  validateRefinement,
  type RefinementDecisionRaw,
  type Refinement,
  type RefinementValidation,
} from '@/lib/app/questionnaire/refinement/refinement-schema';

export {
  buildRefinementPrompt,
  buildRefinementRetryMessage,
} from '@/lib/app/questionnaire/refinement/refinement-prompt';

export {
  normalizeRefinementDecisions,
  applyRefinement,
  summarizeRefinements,
} from '@/lib/app/questionnaire/refinement/refinement-logic';

/**
 * The answer-provenance vocabulary, re-exported for the parity test that asserts
 * F4.4 is the sole emitter of `refined` (it stays out of
 * `EXTRACTOR_EMITTED_PROVENANCES`). Mirrors the contradiction core's re-export of
 * `CONTRADICTION_MODES`. Sourced from the single tuple in `../types.ts`.
 */
export {
  ANSWER_PROVENANCES,
  EXTRACTOR_EMITTED_PROVENANCES,
  type AnswerProvenance,
} from '@/lib/app/questionnaire/types';
