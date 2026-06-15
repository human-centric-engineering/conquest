/**
 * Public surface of the reasoning-trace core (demo feature — "watch it think").
 *
 * Pure, DB-free: the {@link ReasoningStep} shape and the {@link buildReasoningTrace} mapper from a
 * turn's {@link import('@/lib/app/questionnaire/orchestrator/types').TurnResult}. The live `/messages`
 * route consumes these to emit `reasoning` SSE frames; nothing here imports Prisma / Next.js. The
 * placement enum lives in `../types` alongside the other config enums.
 */

export {
  REASONING_STEP_KINDS,
  type ReasoningStepKind,
  REASONING_TONES,
  type ReasoningTone,
  type ReasoningStep,
} from '@/lib/app/questionnaire/reasoning/types';

export {
  buildReasoningTrace,
  type ReasoningTraceOptions,
} from '@/lib/app/questionnaire/reasoning/build-reasoning-trace';
