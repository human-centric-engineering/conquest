/**
 * Cohort Report (report kind `cohort`) — public surface.
 *
 * The cross-respondent analysis/charting/narrative generated over one round's submissions. F14.1
 * lands the analytical substrate (the segmented dataset) + settings projection; later features add
 * charts (F14.2), the narrative agents (F14.3), scoring (F14.4), authoring/editing (F14.5) and
 * versioning/publish/PDF/search (F14.6). Server-only at the seam (the dataset builder touches
 * Prisma); the `types`/`settings` projections are client-safe.
 */

export { narrowCohortReportSettings } from '@/lib/app/questionnaire/cohort-report/settings';
export {
  buildCohortDataset,
  type BuildCohortDatasetParams,
} from '@/lib/app/questionnaire/cohort-report/dataset';
export type {
  SegmentSource,
  SegmentKind,
  SegmentDimension,
  CohortSegment,
  CohortSegmentation,
  CohortDataset,
} from '@/lib/app/questionnaire/cohort-report/types';
export { SUBGROUP_DIMENSION_KEY } from '@/lib/app/questionnaire/cohort-report/types';

export {
  validateCohortReportContent,
  isUsableCohortReportContent,
  buildCohortDatasetDigest,
  buildChartCatalogText,
  type CohortReportContent,
  type CohortReportSection,
} from '@/lib/app/questionnaire/cohort-report/content';
export {
  generateCohortReport,
  type GeneratedCohortReport,
} from '@/lib/app/questionnaire/cohort-report/generate';
export {
  refineCohortReportSection,
  type RefinedSection,
} from '@/lib/app/questionnaire/cohort-report/refine';
export { markdownToHtml } from '@/lib/app/questionnaire/cohort-report/richtext';
export {
  ensureCohortReport,
  appendCohortReportRevision,
  markCohortReportFailed,
} from '@/lib/app/questionnaire/cohort-report/persist';
export {
  buildCohortReportView,
  type CohortReportView,
} from '@/lib/app/questionnaire/cohort-report/view';

export { buildChartData } from '@/lib/app/questionnaire/cohort-report/chart-series';
export {
  COHORT_CHART_KINDS,
  COHORT_CHART_DISPLAYS,
  type CohortChartKind,
  type CohortChartDisplay,
  type ChartSpec,
  type ChartSeriesDef,
  type ChartDatum,
  type ChartData,
} from '@/lib/app/questionnaire/cohort-report/chart-types';
