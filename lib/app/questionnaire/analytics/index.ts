/**
 * F8.1 admin analytics — public surface.
 *
 * Three read-only aggregators over a version's completed-session data (distributions,
 * funnel, cost) plus the shared query contract / scope resolver. Server-only at the
 * seam (the aggregators touch Prisma); the `views` types are client-safe and imported
 * by the admin UI.
 */

export {
  questionnaireAnalyticsQuerySchema,
  resolveAnalyticsScope,
  getAnalyticsDefaultDateInputs,
  type QuestionnaireAnalyticsQuery,
  type AnalyticsScope,
} from '@/lib/app/questionnaire/analytics/query-schema';

export {
  getQuestionDistributions,
  assembleQuestionDistributions,
  DISTRIBUTION_SLOT_SELECT,
  QUESTION_TYPE_LABELS,
  type SlotForDistribution,
  type SessionForDistribution,
  type AnswerForDistribution,
  type AssembledDistributions,
} from '@/lib/app/questionnaire/analytics/distributions';
export { getCompletionFunnel } from '@/lib/app/questionnaire/analytics/funnel';
export { getQuestionnaireCostBreakdown } from '@/lib/app/questionnaire/analytics/cost';
export { getSafeguardingSummary } from '@/lib/app/questionnaire/analytics/safeguarding';

export {
  K_ANONYMITY_THRESHOLD,
  isCohortSuppressed,
} from '@/lib/app/questionnaire/analytics/privacy';

export type {
  AnalyticsRange,
  ProvenanceBreakdown,
  ValueBucket,
  NumericSummary,
  HistogramBin,
  DistributionDetail,
  QuestionDistribution,
  QuestionDistributionsResult,
  FunnelStageKey,
  FunnelStage,
  CompletionFunnelResult,
  CostCapabilityBucket,
  CostDayPoint,
  SessionCostRow,
  QuestionnaireCostResult,
  SafeguardingSummary,
} from '@/lib/app/questionnaire/analytics/views';
