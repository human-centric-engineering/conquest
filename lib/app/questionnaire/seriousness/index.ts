/**
 * Public surface of the questionnaire seriousness / abuse gate core.
 *
 * Pure, DB-free: the in-memory shapes, the verdict Zod contract, the prompt builder, and the
 * escalation/strike logic. The judge invoker (route seam) and the orchestrator consume these;
 * nothing here imports Prisma/Next.js.
 */

export type {
  SeriousnessJudgeInput,
  SeriousnessVerdict,
  AbuseStrikeOutcome,
} from '@/lib/app/questionnaire/seriousness/types';

export {
  seriousnessVerdictSchema,
  validateSeriousnessVerdict,
  SERIOUSNESS_REASON_MAX,
  type SeriousnessVerdictRaw,
} from '@/lib/app/questionnaire/seriousness/judge-schema';

export { buildSeriousnessJudgePrompt } from '@/lib/app/questionnaire/seriousness/judge-prompt';

export {
  seriousnessGateActive,
  evaluateAbuseStrike,
  ABUSE_ABANDON_MESSAGE,
} from '@/lib/app/questionnaire/seriousness/seriousness-logic';
