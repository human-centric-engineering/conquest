/**
 * Public surface of the questionnaire contradiction-detection core (F4.3).
 *
 * Pure, DB-free: the in-memory shapes, the Zod LLM contract + its JSON-schema, the
 * prompt builder, the finding normaliser, and the pure detection scheduler. The
 * detector capability and the preview route consume these; nothing here imports
 * Prisma/Next.js.
 */

export {
  CONTRADICTION_SEVERITIES,
  type ContradictionSeverity,
  type ContradictionSlotView,
  type AnsweredSlotView,
  type ContradictionContext,
  type DetectionPhase,
  type DetectionDecision,
  type ContradictionFinding,
  type PendingContradiction,
  type DroppedFinding,
  type ContradictionDetectionResult,
  type FindingsSummary,
} from '@/lib/app/questionnaire/contradiction/types';

export {
  buildContradictionProbe,
  DEFAULT_RECONCILIATION_QUESTION,
  type ContradictionProbeLabels,
} from '@/lib/app/questionnaire/contradiction/probe-flow';

export {
  contradictionDetectionSchema,
  contradictionDetectionJsonSchema,
  validateContradictionDetection,
  type DetectedContradiction,
  type ContradictionDetection,
  type ContradictionDetectionValidation,
} from '@/lib/app/questionnaire/contradiction/detection-schema';

export {
  buildContradictionDetectionPrompt,
  buildContradictionDetectionRetryMessage,
} from '@/lib/app/questionnaire/contradiction/detection-prompt';

export {
  normalizeContradictionFindings,
  shouldRunDetection,
  summarizeFindings,
} from '@/lib/app/questionnaire/contradiction/detection-logic';

/**
 * The contradiction modes, re-exported for the parity test that asserts the
 * detector's vocabulary and the shared config enum stay in lock-step (mirrors
 * extraction's re-export of `ANSWER_PROVENANCES`). Sourced from the single tuple
 * in `../types.ts`.
 */
export { CONTRADICTION_MODES, type ContradictionMode } from '@/lib/app/questionnaire/types';
