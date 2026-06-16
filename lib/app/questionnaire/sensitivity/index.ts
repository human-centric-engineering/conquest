/**
 * Public surface of the questionnaire sensitivity-awareness / safeguarding core.
 *
 * Pure, DB-free: the in-memory shapes and the severity / signpost logic. The orchestrator and the
 * route consume these; nothing here imports Prisma/Next.js.
 */

export type {
  SensitivityAssessment,
  SensitivityDetectInput,
  SensitivityNote,
  SensitivityOutcome,
} from '@/lib/app/questionnaire/sensitivity/types';

export {
  severityRank,
  runningMaxLevel,
  shouldSignpost,
  mergeSensitivitySignals,
  composeSupportMessage,
  effectiveSupportMessage,
  DEFAULT_SUPPORT_MESSAGE,
} from '@/lib/app/questionnaire/sensitivity/logic';

export { buildSensitivityDetectPrompt } from '@/lib/app/questionnaire/sensitivity/detect-prompt';

export {
  sensitivityDetectVerdictSchema,
  validateSensitivityDetectVerdict,
  normalizeSensitivityVerdict,
  SENSITIVITY_SUMMARY_MAX,
  SENSITIVITY_CATEGORY_MAX,
  type SensitivityDetectVerdictRaw,
} from '@/lib/app/questionnaire/sensitivity/detect-schema';

export {
  keywordSensitivityFloor,
  KEYWORD_NET_CATEGORY,
  KEYWORD_NET_SUMMARY,
} from '@/lib/app/questionnaire/sensitivity/keyword-net';
