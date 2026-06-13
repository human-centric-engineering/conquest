/**
 * Public surface of the questionnaire sensitivity-awareness / safeguarding core.
 *
 * Pure, DB-free: the in-memory shapes and the severity / signpost logic. The orchestrator and the
 * route consume these; nothing here imports Prisma/Next.js.
 */

export type {
  SensitivityAssessment,
  SensitivityNote,
  SensitivityOutcome,
} from '@/lib/app/questionnaire/sensitivity/types';

export {
  severityRank,
  runningMaxLevel,
  shouldSignpost,
  composeSupportMessage,
} from '@/lib/app/questionnaire/sensitivity/logic';
