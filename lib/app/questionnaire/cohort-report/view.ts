/**
 * Cohort Report read view (report kind `cohort`, F14.3).
 *
 * `buildCohortReportView` assembles the client-safe shape the admin surface renders: the report
 * header (status, publish state, cost, revision count), the working-head revision's content, and the
 * dataset the charts render against (the UI resolves each `ChartSpec` → `ChartData` client-side via
 * the pure `buildChartData`). When no report has been generated yet it returns `exists: false` with
 * the dataset, so the UI can show the "Generate" affordance over a live preview of the data.
 * Server-side (touches Prisma); the returned shape is serializable (no Date objects).
 */

import { prisma } from '@/lib/db/client';
import {
  COHORT_REPORT_STATUSES,
  COHORT_REPORT_PUBLISH_STATUSES,
  COHORT_REPORT_AUTHORS,
  narrowToEnum,
  type CohortReportStatus,
  type CohortReportPublishStatus,
  type CohortReportAuthor,
} from '@/lib/app/questionnaire/types';
import { buildCohortDataset } from '@/lib/app/questionnaire/cohort-report/dataset';
import {
  validateCohortReportContent,
  type CohortReportContent,
} from '@/lib/app/questionnaire/cohort-report/content';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

/** The client-safe cohort-report read shape. */
export interface CohortReportView {
  roundId: string;
  versionId: string;
  /** False when no report has been generated for this round yet (UI shows "Generate"). */
  exists: boolean;
  title: string | null;
  status: CohortReportStatus | null;
  publishStatus: CohortReportPublishStatus | null;
  /** Cumulative generation cost, USD. */
  costUsd: number | null;
  error: string | null;
  /** ISO timestamp of the last generation, or null. */
  generatedAt: string | null;
  /** Working-head revision number (the latest), or null when none. */
  revisionNumber: number | null;
  /** How many revisions exist. */
  revisionCount: number;
  authoredBy: CohortReportAuthor | null;
  /** The working-head revision's content, or null when none. */
  content: CohortReportContent | null;
  /** The analytical substrate the charts render against. */
  dataset: CohortDataset;
}

/** Build the read view for a round + version. Always computes the dataset (it's the live preview). */
export async function buildCohortReportView(params: {
  roundId: string;
  roundName: string;
  versionId: string;
  /** A pre-built dataset to reuse (e.g. the generate route already built it); otherwise computed. */
  dataset?: CohortDataset;
}): Promise<CohortReportView> {
  const { roundId, roundName, versionId } = params;

  const dataset = params.dataset ?? (await buildCohortDataset({ roundId, roundName, versionId }));

  const report = await prisma.appCohortReport.findUnique({
    where: { roundId },
    select: {
      title: true,
      status: true,
      publishStatus: true,
      costUsd: true,
      error: true,
      generatedAt: true,
      _count: { select: { revisions: true } },
      revisions: {
        orderBy: { revisionNumber: 'desc' },
        take: 1,
        select: { revisionNumber: true, authoredBy: true, content: true },
      },
    },
  });

  if (!report) {
    return {
      roundId,
      versionId,
      exists: false,
      title: null,
      status: null,
      publishStatus: null,
      costUsd: null,
      error: null,
      generatedAt: null,
      revisionNumber: null,
      revisionCount: 0,
      authoredBy: null,
      content: null,
      dataset,
    };
  }

  const head = report.revisions[0] ?? null;
  return {
    roundId,
    versionId,
    exists: true,
    title: report.title,
    status: narrowToEnum<CohortReportStatus>(report.status, COHORT_REPORT_STATUSES, 'queued'),
    publishStatus: narrowToEnum<CohortReportPublishStatus>(
      report.publishStatus,
      COHORT_REPORT_PUBLISH_STATUSES,
      'draft'
    ),
    costUsd: report.costUsd,
    error: report.error,
    generatedAt: report.generatedAt?.toISOString() ?? null,
    revisionNumber: head?.revisionNumber ?? null,
    revisionCount: report._count.revisions,
    authoredBy: head
      ? narrowToEnum<CohortReportAuthor>(head.authoredBy, COHORT_REPORT_AUTHORS, 'ai')
      : null,
    content: head ? validateCohortReportContent(head.content) : null,
    dataset,
  };
}
