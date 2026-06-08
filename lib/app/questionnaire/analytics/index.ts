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
  QUESTION_TYPE_LABELS,
} from '@/lib/app/questionnaire/analytics/distributions';
export { getCompletionFunnel } from '@/lib/app/questionnaire/analytics/funnel';
export { getQuestionnaireCostBreakdown } from '@/lib/app/questionnaire/analytics/cost';

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
} from '@/lib/app/questionnaire/analytics/views';
