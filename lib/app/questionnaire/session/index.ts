/**
 * Public surface of the questionnaire session state-machine core (F4.6).
 *
 * Pure, DB-free: the lifecycle event-type vocabulary, the transition error, and the
 * deterministic classify/guard/event-mapping functions. The session seam
 * (`app/api/v1/app/questionnaires/_lib/sessions.ts`) and the transition route consume
 * these; nothing here imports Prisma / Next.js.
 */

export {
  SESSION_EVENT_TYPES,
  type SessionEventType,
  type TransitionClassification,
  SessionTransitionError,
} from '@/lib/app/questionnaire/session/types';

export {
  isTerminal,
  classifyTransition,
  canTransition,
  assertTransition,
  eventTypeFor,
} from '@/lib/app/questionnaire/session/session-logic';

export {
  SOFT_CAP_RATIO,
  type CostCapTier,
  classifyCostCap,
} from '@/lib/app/questionnaire/session/cost-cap';
